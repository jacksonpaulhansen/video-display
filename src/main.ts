import './style.css';
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

type PublishStatus = 'IDLE' | 'RUNNING' | 'PACKING' | 'DONE' | 'FAILED';
type VideoPlatform = 'youtube' | 'direct' | 'iframe' | null;

type BridgeExtras = EvenAppBridge & {
  shutDownPageContainer?: (confirmMode: number) => Promise<unknown>;
};

type ImageFilters = {
  brightness: number; // -100 … 100, 0 = normal
  contrast: number;   // -100 … 100, 0 = normal
  invert: boolean;
  zoom: number;       // 1.0 … 4.0
  panX: number;       // -100 … 100, 0 = center
  panY: number;       // -100 … 100, 0 = center
  imgBig: boolean;    // false = 1 tile 200×100, true = 4 tiles 400×200
};

type UserSettings = {
  fps: number;
  autoplay: boolean;
  muted: boolean;
  showControlsKey: boolean;
  filters: ImageFilters;
};

type VideoState = {
  inputUrl: string;
  embedUrl: string | null;
  platform: VideoPlatform;
  loaded: boolean;
};

type AppState = {
  publishStatus: PublishStatus;
  deployed: boolean;
  video: VideoState;
  userSettings: UserSettings;
  bridgeConnected: boolean;
};

// ── Constants ─────────────────────────────────────────────────────────────────

let CONTROL_URL = `http://${window.location.hostname || 'localhost'}:8787`;
const REQUIRED_CONTROL_CAPABILITY = 'publish-app';
const HIDE_DEBUG_TOOLS = true;
const DEV_TOOLS_TOGGLE_SHORTCUT = 'Ctrl+Shift+D';
const MAX_APP_NAME_LENGTH = 20;

// Glasses image container — SDK max: 200×100 px per tile
const IMAGE_TILE_W = 200;
const IMAGE_TILE_H = 100;
// Small: 1 tile centered; Big: 2×2 grid of tiles = 400×200 total
const TILE_IDS   = [1, 2, 3, 4] as const;
const TILE_NAMES = ['tile1', 'tile2', 'tile3', 'tile4'] as const;
// Big mode tile positions (TL, TR, BL, BR) — 4 tiles centered on 576×288
const BIG_X = (576 - IMAGE_TILE_W * 2) / 2; // 88
const BIG_Y = (288 - IMAGE_TILE_H * 2) / 2; // 44
const SMALL_X = (576 - IMAGE_TILE_W) / 2;   // 188
const SMALL_Y = (288 - IMAGE_TILE_H) / 2;   // 94

const BROWSER_STORAGE_KEY = 'video-display:v2';
const DEFAULT_FPS = 30;
const MIN_FPS = 1;
const MAX_FPS = 60;

const DEFAULT_FILTERS: ImageFilters = {
  brightness: 0,
  contrast: 0,
  invert: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  imgBig: false,
};

// ── State ─────────────────────────────────────────────────────────────────────

const state: AppState = {
  publishStatus: 'IDLE',
  deployed: false,
  video: { inputUrl: '', embedUrl: null, platform: null, loaded: false },
  userSettings: {
    fps: DEFAULT_FPS,
    autoplay: false,
    muted: true,
    showControlsKey: true,

    filters: { ...DEFAULT_FILTERS },
  },
  bridgeConnected: false,
};

let bridge: EvenAppBridge | null = null;
let startupCreated = false;
let imageContainerActive = false;
let debugToolsVisible = !HIDE_DEBUG_TOOLS;

// Frame capture
let isTransmittingFrame = false;
let frameIntervalId: ReturnType<typeof setInterval> | null = null;
let _frameLoggedSkip = false;
// Master canvas — small: 200×100, big: 400×200
const captureCanvas = document.createElement('canvas');
captureCanvas.width = IMAGE_TILE_W;
captureCanvas.height = IMAGE_TILE_H;
const captureCtx = captureCanvas.getContext('2d')!;

// Reusable video element
const videoEl = document.createElement('video');
videoEl.crossOrigin = 'anonymous';
videoEl.preload = 'auto';
videoEl.addEventListener('loadeddata', () => {
  if (state.video.platform === 'direct') {
    startFrameCapture();
    void captureAndSendFrame();
  }
});

// Diagnostic log
const eventLines: string[] = [];
let lastEventAt = 0;
let lastEventSignature = '';
let lastEventLabel = '';

// ── DOM ───────────────────────────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root element');

function requireElement<T extends Element>(v: T | null, name: string): T {
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

app.innerHTML = `
  <main class="hud-shell">

    <fieldset class="group-box">
      <legend>Video Display</legend>
      <div class="url-row">
        <div class="mini-field url-field">
          <label>Video URL</label>
          <input id="video-url-input" type="text" placeholder="YouTube URL or direct .mp4/.webm link" />
        </div>
        <button id="load-video-btn" type="button">Load</button>
        <button id="browse-video-btn" type="button">Browse</button>
        <input id="video-file-input" type="file" accept="video/*" style="display:none" />
        <button id="clear-video-btn" type="button">Clear</button>
      </div>
      <div id="video-container" class="video-container">
        <div class="video-placeholder">Enter a video URL above and click Load</div>
      </div>
      <div class="controls-key">
        <span class="controls-key-item">⬤ Click — Play / Pause</span>
        <span class="controls-key-item">▲ Up — +10s</span>
        <span class="controls-key-item">▼ Down — −10s</span>
        <span class="controls-key-item">⬤⬤ Double — Mute toggle</span>
      </div>
      <p id="glasses-status" class="hint"></p>
    </fieldset>

    <fieldset class="group-box">
      <legend>User Settings</legend>
      <div class="settings-row">
        <div class="mini-field">
          <label>FPS</label>
          <input id="fps-input" type="number" min="${MIN_FPS}" max="${MAX_FPS}" value="${DEFAULT_FPS}" />
          <span class="field-unit">fps</span>
        </div>
        <label class="toggle-label"><input id="autoplay-toggle" type="checkbox" /> Autoplay</label>
        <label class="toggle-label"><input id="muted-toggle" type="checkbox" checked /> Muted</label>
        <label class="toggle-label"><input id="show-key-toggle" type="checkbox" checked /> Show Key on Glasses</label>
      </div>
      <div class="slider-grid">
        <button class="slider-lbl" data-target="brightness-slider" data-default="0">Brightness</button>
        <input type="range" id="brightness-slider" min="-100" max="100" value="0" step="1" />
        <span class="slider-val" id="brightness-val">0</span>

        <button class="slider-lbl" data-target="contrast-slider" data-default="0">Contrast</button>
        <input type="range" id="contrast-slider" min="-100" max="100" value="0" step="1" />
        <span class="slider-val" id="contrast-val">0</span>

        <label class="toggle-label slider-full"><input id="invert-toggle" type="checkbox" /> Invert</label>

        <button class="slider-lbl" data-target="zoom-slider" data-default="1">Zoom</button>
        <input type="range" id="zoom-slider" min="1" max="4" value="1" step="0.05" />
        <span class="slider-val" id="zoom-val">1.0×</span>

        <button class="slider-lbl" data-target="panx-slider" data-default="0">L / R</button>
        <input type="range" id="panx-slider" min="-100" max="100" value="0" step="1" />
        <span class="slider-val" id="panx-val">0</span>

        <button class="slider-lbl" data-target="pany-slider" data-default="0">U / D</button>
        <input type="range" id="pany-slider" min="-100" max="100" value="0" step="1" />
        <span class="slider-val" id="pany-val">0</span>

        <span class="slider-lbl" style="cursor:default">Img Size</span>
        <div class="img-size-toggle slider-full">
          <button id="img-small-btn" class="size-btn size-btn--active" type="button">Small</button>
          <button id="img-big-btn" class="size-btn" type="button">Big</button>
        </div>
      </div>
    </fieldset>

    <fieldset id="debug-tools" class="group-box" ${HIDE_DEBUG_TOOLS ? 'style="display:none;"' : ''}>
      <legend>Debug Tools</legend>
      <div class="controls">
        <button id="publish-btn" type="button">Publish App</button>
        <button id="ehpk-btn" type="button">Build EHPK</button>
        <span id="publish-status">IDLE</span>
      </div>
      <pre id="event-log" class="event-log"></pre>
      <pre id="publish-log" class="publish-log"></pre>
      <div class="sim-display">
        <canvas id="hud-image-preview" class="hud-image-preview"></canvas>
      </div>
      <p class="hint">Toggle: ${DEV_TOOLS_TOGGLE_SHORTCUT}</p>
    </fieldset>

  </main>
`;

const videoUrlInput  = requireElement(document.querySelector<HTMLInputElement>('#video-url-input'), '#video-url-input');
const loadVideoBtn   = requireElement(document.querySelector<HTMLButtonElement>('#load-video-btn'), '#load-video-btn');
const browseVideoBtn = requireElement(document.querySelector<HTMLButtonElement>('#browse-video-btn'), '#browse-video-btn');
const videoFileInput = requireElement(document.querySelector<HTMLInputElement>('#video-file-input'), '#video-file-input');
const clearVideoBtn  = requireElement(document.querySelector<HTMLButtonElement>('#clear-video-btn'), '#clear-video-btn');
const videoContainer = requireElement(document.querySelector<HTMLDivElement>('#video-container'), '#video-container');
const glassesStatus  = requireElement(document.querySelector<HTMLParagraphElement>('#glasses-status'), '#glasses-status');
const fpsInput       = requireElement(document.querySelector<HTMLInputElement>('#fps-input'), '#fps-input');
const autoplayToggle = requireElement(document.querySelector<HTMLInputElement>('#autoplay-toggle'), '#autoplay-toggle');
const mutedToggle    = requireElement(document.querySelector<HTMLInputElement>('#muted-toggle'), '#muted-toggle');
const invertToggle          = requireElement(document.querySelector<HTMLInputElement>('#invert-toggle'), '#invert-toggle');
const showKeyToggle         = requireElement(document.querySelector<HTMLInputElement>('#show-key-toggle'), '#show-key-toggle');

// Sliders
const brightnessSlider = requireElement(document.querySelector<HTMLInputElement>('#brightness-slider'), '#brightness-slider');
const contrastSlider   = requireElement(document.querySelector<HTMLInputElement>('#contrast-slider'), '#contrast-slider');
const zoomSlider       = requireElement(document.querySelector<HTMLInputElement>('#zoom-slider'), '#zoom-slider');
const panxSlider       = requireElement(document.querySelector<HTMLInputElement>('#panx-slider'), '#panx-slider');
const panySlider       = requireElement(document.querySelector<HTMLInputElement>('#pany-slider'), '#pany-slider');
const brightnessVal    = requireElement(document.querySelector<HTMLSpanElement>('#brightness-val'), '#brightness-val');
const contrastVal      = requireElement(document.querySelector<HTMLSpanElement>('#contrast-val'), '#contrast-val');
const zoomVal          = requireElement(document.querySelector<HTMLSpanElement>('#zoom-val'), '#zoom-val');
const panxVal          = requireElement(document.querySelector<HTMLSpanElement>('#panx-val'), '#panx-val');
const panyVal          = requireElement(document.querySelector<HTMLSpanElement>('#pany-val'), '#pany-val');
const imgSmallBtn      = requireElement(document.querySelector<HTMLButtonElement>('#img-small-btn'), '#img-small-btn');
const imgBigBtn        = requireElement(document.querySelector<HTMLButtonElement>('#img-big-btn'), '#img-big-btn');

const publishBtn         = requireElement(document.querySelector<HTMLButtonElement>('#publish-btn'), '#publish-btn');
const ehpkBtn            = requireElement(document.querySelector<HTMLButtonElement>('#ehpk-btn'), '#ehpk-btn');
const debugToolsFieldset = requireElement(document.querySelector<HTMLElement>('#debug-tools'), '#debug-tools');
const publishStatus      = requireElement(document.querySelector<HTMLSpanElement>('#publish-status'), '#publish-status');
const eventLog           = requireElement(document.querySelector<HTMLPreElement>('#event-log'), '#event-log');
const publishLog         = requireElement(document.querySelector<HTMLPreElement>('#publish-log'), '#publish-log');
const hudImagePreview    = requireElement(document.querySelector<HTMLCanvasElement>('#hud-image-preview'), '#hud-image-preview');


function updateHudPreviewLayout(): void {
  const big = state.userSettings.filters.imgBig;
  const totalW = big ? IMAGE_TILE_W * 2 : IMAGE_TILE_W;
  const totalH = big ? IMAGE_TILE_H * 2 : IMAGE_TILE_H;
  const x = (576 - totalW) / 2;
  const y = (288 - totalH) / 2;
  hudImagePreview.width  = totalW;
  hudImagePreview.height = totalH;
  hudImagePreview.style.cssText =
    `position:absolute;` +
    `left:${(x / 576) * 100}%;` +
    `top:${(y / 288) * 100}%;` +
    `width:${(totalW / 576) * 100}%;` +
    `height:${(totalH / 288) * 100}%;` +
    `border:1px solid rgba(0,200,255,0.4);` +
    `image-rendering:pixelated;`;
}

updateHudPreviewLayout();

// ── Diagnostic log ────────────────────────────────────────────────────────────

function log(line: string): void {
  const ts = new Date().toLocaleTimeString();
  eventLines.push(`${ts}  ${line}`);
  while (eventLines.length > 40) eventLines.shift();
  eventLog.textContent = eventLines.join('\n');
  eventLog.scrollTop = eventLog.scrollHeight;
  console.log(`[video-display] ${line}`);
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function parseYoutubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v) return v;
      const match = parsed.pathname.match(/\/(?:embed|shorts|v)\/([^/?&#]+)/);
      return match?.[1] ?? null;
    }
    if (host === 'youtu.be') return parsed.pathname.slice(1).split('?')[0] || null;
  } catch { /* ignore */ }
  return null;
}

function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href;
  } catch { return null; }
}

function buildEmbedUrl(rawUrl: string): { embedUrl: string; platform: Exclude<VideoPlatform, null> } | null {
  const url = rawUrl.trim();
  if (!url) return null;

  const youtubeId = parseYoutubeId(url);
  if (youtubeId) {
    const params = new URLSearchParams({ rel: '0' });
    if (state.userSettings.autoplay) params.set('autoplay', '1');
    if (state.userSettings.muted) params.set('mute', '1');
    return { embedUrl: `https://www.youtube.com/embed/${youtubeId}?${params}`, platform: 'youtube' };
  }

  const safe = sanitizeUrl(url);
  if (!safe) return null;

  try {
    const ext = new URL(safe).pathname.toLowerCase().split('?')[0];
    if (/\.(mp4|webm|ogg|mov|m4v)$/.test(ext)) return { embedUrl: safe, platform: 'direct' };
  } catch { /* ignore */ }

  return { embedUrl: safe, platform: 'iframe' };
}



// ── Canvas filter + transform pipeline ───────────────────────────────────────

function buildCssFilter(): string {
  const { brightness, contrast, invert } = state.userSettings.filters;
  const parts: string[] = [];
  if (brightness !== 0) parts.push(`brightness(${Math.max(0, 1 + brightness / 100).toFixed(2)})`);
  if (contrast !== 0) parts.push(`contrast(${Math.max(0, 1 + contrast / 100).toFixed(2)})`);
  if (invert) parts.push('invert(1)');
  return parts.join(' ') || 'none';
}

function drawFilteredFrame(): void {
  const { zoom, panX, panY, imgBig } = state.userSettings.filters;
  const cw = imgBig ? IMAGE_TILE_W * 2 : IMAGE_TILE_W;
  const ch = imgBig ? IMAGE_TILE_H * 2 : IMAGE_TILE_H;

  if (captureCanvas.width !== cw)  captureCanvas.width  = cw;
  if (captureCanvas.height !== ch) captureCanvas.height = ch;

  captureCtx.filter = 'none';
  captureCtx.fillStyle = '#000';
  captureCtx.fillRect(0, 0, cw, ch);

  captureCtx.save();
  captureCtx.filter = buildCssFilter();

  const tx = (panX / 100) * (cw * (zoom - 1)) / 2;
  const ty = (panY / 100) * (ch * (zoom - 1)) / 2;
  captureCtx.translate(cw / 2 + tx, ch / 2 + ty);
  captureCtx.scale(zoom, zoom);
  captureCtx.drawImage(videoEl, -cw / 2, -ch / 2, cw, ch);

  captureCtx.restore();
}

function applyFiltersToBrowserVideo(): void {
  const target = state.video.platform === 'direct'
    ? videoEl as HTMLElement
    : videoContainer.querySelector<HTMLElement>('iframe');
  if (!target) return;

  const { zoom, panX, panY } = state.userSettings.filters;
  target.style.filter = buildCssFilter() === 'none' ? '' : buildCssFilter();

  if (zoom !== 1 || panX !== 0 || panY !== 0) {
    // % translate is relative to the element size, applied before scale
    const maxPct = (1 - 1 / zoom) * 50;
    const tx = (panX / 100) * maxPct;
    const ty = (panY / 100) * maxPct;
    target.style.transform = `scale(${zoom}) translate(${tx}%, ${ty}%)`;
    target.style.transformOrigin = '50% 50%';
  } else {
    target.style.transform = '';
  }
}

// ── Frame capture ─────────────────────────────────────────────────────────────

function stopFrameCapture(): void {
  if (frameIntervalId !== null) { clearInterval(frameIntervalId); frameIntervalId = null; }
}

function startFrameCapture(): void {
  stopFrameCapture();
  if (!state.video.loaded || state.video.platform !== 'direct') return;

  const ms = Math.max(100, Math.round(1000 / state.userSettings.fps));
  frameIntervalId = setInterval(() => void captureAndSendFrame(), ms);
}

async function captureAndSendFrame(): Promise<void> {
  if (isTransmittingFrame) return;

  if (videoEl.readyState < 2) {
    if (!_frameLoggedSkip) {
      log(`Frame: skip — readyState=${videoEl.readyState}`);
      _frameLoggedSkip = true;
    }
    return;
  }
  _frameLoggedSkip = false;

  drawFilteredFrame();

  // Mirror to debug preview
  const previewCtx = hudImagePreview.getContext('2d');
  if (previewCtx) previewCtx.drawImage(captureCanvas, 0, 0, captureCanvas.width, captureCanvas.height);

  if (!bridge || !imageContainerActive) {
    if (!_frameLoggedSkip) {
      log(`Frame: no bridge=${!bridge} imgActive=${imageContainerActive}`);
      _frameLoggedSkip = true;
    }
    return;
  }

  isTransmittingFrame = true;
  try {
    // Single tile — captureCanvas is 200×100 (small) or 400×200 (big), matching the image container
    const base64 = captureCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: TILE_IDS[0],
      containerName: TILE_NAMES[0],
      imageData: base64,
    }));
    if (!ImageRawDataUpdateResult.isSuccess(result)) {
      log(`Frame: failed — ${String(result)}`);
    }
  } catch (err) {
    log(`Frame: send threw — ${String(err)}`);
  } finally {
    isTransmittingFrame = false;
  }
}

// ── Glasses page ──────────────────────────────────────────────────────────────

const KEY_CONTAINER_ID   = 5;
const KEY_CONTAINER_NAME = 'key';

// Always 2 containers: 1 image (video) + 1 capture text (left strip, never overlaps image).
// Keeping container count/type constant means rebuildPageContainer always succeeds.
function buildGlassesPayload(): { containerTotalNum: number; imageObject: ImageContainerProperty[]; textObject: TextContainerProperty[] } {
  const big = state.userSettings.filters.imgBig;
  const imgW = big ? IMAGE_TILE_W * 2 : IMAGE_TILE_W;
  const imgH = big ? IMAGE_TILE_H * 2 : IMAGE_TILE_H;
  const imgX = big ? BIG_X : SMALL_X;
  const imgY = big ? BIG_Y : SMALL_Y;
  return {
    containerTotalNum: 2,
    imageObject: [new ImageContainerProperty({ containerID: TILE_IDS[0], containerName: TILE_NAMES[0], xPosition: imgX, yPosition: imgY, width: imgW, height: imgH })],
    // Left strip (x=0..BIG_X=88) never overlaps image tiles in any mode
    textObject: [new TextContainerProperty({ containerID: KEY_CONTAINER_ID, containerName: KEY_CONTAINER_NAME, xPosition: 0, yPosition: 0, width: BIG_X, height: 288, content: '', isEventCapture: 1 })],
  };
}

async function setupGlassesPage(withImage: boolean): Promise<void> {
  if (!bridge) return;

  const payload = buildGlassesPayload();

  try {
    if (!startupCreated) {
      const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload));
      log(`createStartUp result=${result}`);
      startupCreated = result === 0;
      if (!startupCreated) {
        const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(payload));
        log(`rebuild result=${ok}`);
        startupCreated = !!ok;
      }
    } else {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(payload));
      log(`rebuild result=${ok}`);
    }
  } catch (err) {
    log(`setupGlassesPage error: ${String(err)}`);
  }

  imageContainerActive = withImage && startupCreated;
  log(`Glasses page: withImage=${withImage} active=${imageContainerActive}`);
  if (imageContainerActive) void captureAndSendFrame();
}

// ── Video rendering ───────────────────────────────────────────────────────────

function renderVideo(): void {
  if (!state.video.loaded || !state.video.embedUrl) {
    videoContainer.innerHTML = '<div class="video-placeholder">Enter a video URL above and click Load</div>';
    return;
  }

  videoContainer.innerHTML = '';

  if (state.video.platform === 'direct') {
    videoEl.src = state.video.embedUrl;
    videoEl.controls = true;
    videoEl.muted = state.userSettings.muted;
    videoEl.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;background:#000;';
    videoContainer.appendChild(videoEl);
    if (state.userSettings.autoplay) videoEl.play().catch(() => undefined);
  } else {
    const iframe = document.createElement('iframe');
    iframe.className = 'video-frame';
    iframe.src = state.video.embedUrl;
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    if (state.video.platform === 'youtube') {
      iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    }
    videoContainer.appendChild(iframe);
  }

  applyFiltersToBrowserVideo();
}

function updateGlassesStatus(): void {
  if (!state.video.loaded) { glassesStatus.textContent = ''; return; }
  if (!state.bridgeConnected) {
    glassesStatus.textContent = 'Glasses not connected — video plays in browser only.';
    return;
  }
  if (state.video.platform === 'direct') {
    const label = parseYoutubeId(state.video.inputUrl) ? 'YouTube' : 'Video';
    glassesStatus.textContent = `${label} streaming to glasses at ${state.userSettings.fps} fps.`;
  } else if (state.video.platform === 'youtube') {
    glassesStatus.textContent = 'YouTube plays in browser only. Use Browse to pick a local video for glasses.';
  } else {
    glassesStatus.textContent = 'Video plays in browser. Glasses show nothing (not a direct video URL).';
  }
}

// ── Slider helpers ────────────────────────────────────────────────────────────

function updateSliderDisplays(): void {
  const f = state.userSettings.filters;
  brightnessSlider.value = String(f.brightness);
  contrastSlider.value   = String(f.contrast);
  zoomSlider.value       = String(f.zoom);
  panxSlider.value       = String(f.panX);
  panySlider.value       = String(f.panY);
  invertToggle.checked   = f.invert;

  imgSmallBtn.classList.toggle('size-btn--active', !f.imgBig);
  imgBigBtn.classList.toggle('size-btn--active',   f.imgBig);
  brightnessVal.textContent  = String(f.brightness);
  contrastVal.textContent    = String(f.contrast);
  zoomVal.textContent        = `${f.zoom.toFixed(2)}×`;
  panxVal.textContent        = String(f.panX);
  panyVal.textContent        = String(f.panY);
}

function onFiltersChanged(): void {
  updateSliderDisplays();
  applyFiltersToBrowserVideo();
  persistUserSettings();
  void captureAndSendFrame();
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(): void {
  renderVideo();
  updateGlassesStatus();
  publishStatus.textContent = state.publishStatus;
  publishBtn.textContent = state.deployed ? 'Update App' : 'Publish App';
}

// ── Load / clear ──────────────────────────────────────────────────────────────

async function loadVideo(): Promise<void> {
  const raw = videoUrlInput.value.trim();
  if (!raw) return;

  let result = buildEmbedUrl(raw);
  if (!result) {
    state.video = { inputUrl: raw, embedUrl: null, platform: null, loaded: false };
    videoContainer.innerHTML = '<div class="video-placeholder error">Invalid URL — enter a valid http/https URL.</div>';
    glassesStatus.textContent = '';
    return;
  }

  stopFrameCapture();
  state.video = { inputUrl: raw, embedUrl: result.embedUrl, platform: result.platform, loaded: true };
  persistUserSettings();

  if (bridge) await setupGlassesPage(result.platform === 'direct');

  render();
  if (result.platform === 'direct') startFrameCapture();
}

function clearVideo(): void {
  stopFrameCapture();
  videoEl.pause();
  videoEl.src = '';
  state.video = { inputUrl: '', embedUrl: null, platform: null, loaded: false };
  videoUrlInput.value = '';
  imageContainerActive = false;
  if (bridge && startupCreated) void setupGlassesPage(false);
  render();
}

// ── Persistence ───────────────────────────────────────────────────────────────

function persistUserSettings(): void {
  try { window.localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state.userSettings)); } catch { /* ignore */ }
}

function loadUserSettings(): void {
  try {
    const raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<UserSettings & { filters?: Partial<ImageFilters> }>;
    if (typeof parsed.fps === 'number') state.userSettings.fps = clampFps(parsed.fps);
    if (typeof parsed.autoplay === 'boolean') state.userSettings.autoplay = parsed.autoplay;
    if (typeof parsed.muted === 'boolean') state.userSettings.muted = parsed.muted;
    if (typeof parsed.showControlsKey === 'boolean') state.userSettings.showControlsKey = parsed.showControlsKey;
    if (parsed.filters) {
      const f = parsed.filters;
      if (typeof f.brightness === 'number') state.userSettings.filters.brightness = clamp(f.brightness, -100, 100);
      if (typeof f.contrast === 'number')   state.userSettings.filters.contrast   = clamp(f.contrast, -100, 100);
      if (typeof f.invert === 'boolean')    state.userSettings.filters.invert     = f.invert;
      if (typeof f.zoom === 'number')       state.userSettings.filters.zoom       = clamp(f.zoom, 1, 4);
      if (typeof f.panX === 'number')       state.userSettings.filters.panX       = clamp(f.panX, -100, 100);
      if (typeof f.panY === 'number')       state.userSettings.filters.panY       = clamp(f.panY, -100, 100);
      if (typeof f.imgBig === 'boolean')     state.userSettings.filters.imgBig     = f.imgBig;
    }
  } catch { /* ignore */ }
}

function syncAllInputs(): void {
  fpsInput.value = String(state.userSettings.fps);
  autoplayToggle.checked = state.userSettings.autoplay;
  mutedToggle.checked = state.userSettings.muted;
  showKeyToggle.checked = state.userSettings.showControlsKey ?? true;
  updateSliderDisplays();
}

function clampFps(v: number): number {
  return !Number.isFinite(v) ? DEFAULT_FPS : Math.max(MIN_FPS, Math.min(MAX_FPS, Math.trunc(v)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clampAppName(v: string): string {
  return String(v || '').trim().slice(0, MAX_APP_NAME_LENGTH);
}

// ── Bridge events ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEventType(event: any): unknown {
  return event?.listEvent?.eventType
    ?? event?.textEvent?.eventType
    ?? event?.sysEvent?.eventType
    ?? event?.listEvent?.type
    ?? event?.textEvent?.type
    ?? event?.sysEvent?.type
    ?? event?.eventType
    ?? event?.type
    ?? event?.name;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapEventType(eventType: unknown): string | null {
  if (eventType === undefined || eventType === null) return null;
  const n = OsEventTypeList.fromJson?.(eventType);
  if (n === OsEventTypeList.CLICK_EVENT   || eventType === OsEventTypeList.CLICK_EVENT   || eventType === 0) return 'CLICK';
  if (n === OsEventTypeList.SCROLL_TOP_EVENT    || eventType === OsEventTypeList.SCROLL_TOP_EVENT    || eventType === 1) return 'UP';
  if (n === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === 2) return 'DOWN';
  if (n === OsEventTypeList.DOUBLE_CLICK_EVENT  || eventType === OsEventTypeList.DOUBLE_CLICK_EVENT  || eventType === 3) return 'DOUBLE_CLICK';
  const t = String(eventType).toUpperCase();
  if (t.includes('DOUBLE') && (t.includes('CLICK') || t.includes('TAP'))) return 'DOUBLE_CLICK';
  if (t.includes('SCROLL_TOP')    || t === 'UP'   || t.includes('SWIPE_UP'))   return 'UP';
  if (t.includes('SCROLL_BOTTOM') || t === 'DOWN' || t.includes('SWIPE_DOWN')) return 'DOWN';
  if ((t.includes('SINGLE') && (t.includes('CLICK') || t.includes('TAP'))) || t === 'CLICK' || t === 'TAP' || t.includes('CLICK_EVENT')) return 'CLICK';
  return null;
}

function isDuplicateEvent(event: unknown, label: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = event as any;
  const sig = JSON.stringify({ l: p?.listEvent ?? null, t: p?.textEvent ?? null, s: p?.sysEvent ?? null, e: p?.eventType ?? null, ty: p?.type ?? null });
  const now = Date.now();
  if (label === lastEventLabel && sig === lastEventSignature && now - lastEventAt < 140) return true;
  lastEventLabel = label; lastEventSignature = sig; lastEventAt = now;
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shouldTreatAsClick(event: any): boolean {
  const explicit = mapEventType(extractEventType(event));
  if (explicit) return false;
  // Any unresolved event is treated as a click, except right after a double-click
  const sinceLast = Date.now() - lastEventAt;
  if (lastEventLabel === 'DOUBLE_CLICK' && sinceLast < 350) return false;
  return true;
}

function handleHubEvent(event: unknown): void {
  log(`raw: ${JSON.stringify(event).slice(0, 120)}`);
  const eventType = extractEventType(event);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const action = mapEventType(eventType) ?? (shouldTreatAsClick(event as any) ? 'CLICK' : null);
  const eventLabel = action ?? 'NONE';
  if (isDuplicateEvent(event, eventLabel)) return;
  log(eventLabel);
  if (action) console.log('[hub-event]', { action, eventType, event });
  if (!action || !state.video.loaded || state.video.platform !== 'direct') return;
  if (action === 'CLICK') {
    if (videoEl.paused) videoEl.play().catch(() => undefined);
    else videoEl.pause();
  } else if (action === 'UP') {
    videoEl.currentTime = Math.min(videoEl.currentTime + 10, videoEl.duration || Infinity);
  } else if (action === 'DOWN') {
    videoEl.currentTime = Math.max(videoEl.currentTime - 10, 0);
  } else if (action === 'DOUBLE_CLICK') {
    state.userSettings.muted = !state.userSettings.muted;
    videoEl.muted = state.userSettings.muted;
    mutedToggle.checked = state.userSettings.muted;
    persistUserSettings();
  }
}

// ── Publish / EHPK ────────────────────────────────────────────────────────────

async function publishApp(): Promise<void> {
  if (state.publishStatus === 'RUNNING') { publishLog.textContent = 'Already running…'; return; }

  const configRes = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configRes?.json().catch(() => null)) as
    | { config?: { appName?: string; github?: { repo?: string } } } | null;

  const savedRepo = (configBody?.config?.github?.repo ?? '').trim();
  const defaultName = clampAppName(savedRepo || configBody?.config?.appName || 'video-display');
  let appName = defaultName;

  if (!savedRepo) {
    const input = window.prompt(`App name (max ${MAX_APP_NAME_LENGTH} chars):`, defaultName);
    appName = clampAppName(input ?? '');
    if (!appName) { publishLog.textContent = 'Cancelled.'; return; }
  }

  state.publishStatus = 'RUNNING';
  publishBtn.disabled = true; ehpkBtn.disabled = true;
  publishLog.textContent = `Publishing "${appName}"…`;
  publishStatus.textContent = state.publishStatus;

  try {
    let response = await fetch(`${CONTROL_URL}/publish-app`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appName }),
    });
    let body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; code?: string; publishUrl?: string } | null;

    if (!response.ok && (body?.code === 'PAT_REQUIRED' || body?.code === 'INVALID_PAT')) {
      const pat = window.prompt(body.code === 'INVALID_PAT' ? 'Saved PAT is invalid. New PAT:' : 'GitHub PAT required:');
      if (!pat?.trim()) throw new Error('PAT required.');
      response = await fetch(`${CONTROL_URL}/publish-app`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appName, pat: pat.trim() }),
      });
      body = (await response.json().catch(() => null)) as { error?: string; logs?: string; publishUrl?: string } | null;
    }

    if (!response.ok) {
      if (response.status === 409) { publishLog.textContent = 'Already running.'; return; }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    state.publishStatus = 'DONE'; state.deployed = true;
    publishLog.textContent = `${body?.logs ?? 'Done.'}\n\n${body?.publishUrl ?? ''}`;
  } catch (e) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(e)}`;
  } finally {
    publishBtn.disabled = false; ehpkBtn.disabled = false;
    publishStatus.textContent = state.publishStatus;
    publishBtn.textContent = state.deployed ? 'Update App' : 'Publish App';
  }
}

async function buildEhpk(): Promise<void> {
  if (state.publishStatus === 'RUNNING' || state.publishStatus === 'PACKING') {
    publishLog.textContent = 'Another operation is in progress.'; return;
  }

  const configRes = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configRes?.json().catch(() => null)) as { config?: { appName?: string } } | null;
  const defaultName = clampAppName((configBody?.config?.appName ?? 'video-display').trim() || 'video-display');
  const appName = clampAppName(window.prompt(`App name for .ehpk (max ${MAX_APP_NAME_LENGTH} chars):`, defaultName) ?? '');
  if (!appName) { publishLog.textContent = 'Cancelled.'; return; }

  state.publishStatus = 'PACKING';
  publishBtn.disabled = true; ehpkBtn.disabled = true;
  publishLog.textContent = `Building .ehpk for "${appName}"…`;
  publishStatus.textContent = state.publishStatus;

  try {
    const response = await fetch(`${CONTROL_URL}/build-ehpk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appName }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string; logs?: string; outputPath?: string } | null;
    if (!response.ok) {
      if (response.status === 409) { publishLog.textContent = 'Already running.'; return; }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }
    state.publishStatus = 'DONE';
    publishLog.textContent = `${body?.logs ?? 'Done.'}\n\n${body?.outputPath ?? ''}`;
  } catch (e) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(e)}`;
  } finally {
    publishBtn.disabled = false; ehpkBtn.disabled = false;
    publishStatus.textContent = state.publishStatus;
  }
}

// ── Bridge init ───────────────────────────────────────────────────────────────

async function initBridge(): Promise<void> {
  window.addEventListener('evenHubEvent', (e) => handleHubEvent((e as CustomEvent).detail));
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, rej) => window.setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    state.bridgeConnected = true;
    const b = bridge as BridgeExtras;
    log(`Bridge connected. canExit=${!!b.shutDownPageContainer}`);
    await setupGlassesPage(false);
    bridge.onEvenHubEvent((e) => handleHubEvent(e));
    log('Event listener registered');
  } catch (err) {
    log(`Bridge unavailable: ${String(err)}`);
    bridge = null; state.bridgeConnected = false;
  }
}

async function resolveControlUrl(): Promise<void> {
  // When served by Vite (dev/sim) from a LAN IP, window.location.hostname is the
  // PC's LAN IP — already correct, skip host.json.
  // When EvenHub serves the EHPK on-device, hostname is '' / 'localhost' / '127.0.0.1'
  // (device loopback) — must use host.json to reach the PC's control server.
  const h = window.location.hostname;
  const isLoopback = !h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  if (!isLoopback) return;
  try {
    const r = await fetch('/host.json', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = (await r.json()) as { host?: string; port?: number };
      if (data.host) {
        CONTROL_URL = `http://${data.host}:${data.port ?? 8787}`;
        log(`Control URL from host.json: ${CONTROL_URL}`);
      }
    }
  } catch { /* not available */ }
}

async function initControlHealth(): Promise<void> {
  try {
    const h = await fetch(`${CONTROL_URL}/health`, { cache: 'no-store' });
    const info = (await h.json().catch(() => null)) as { capabilities?: string[]; version?: string } | null;
    publishLog.textContent = !h.ok || !info?.capabilities?.includes(REQUIRED_CONTROL_CAPABILITY)
      ? 'Control server outdated. Run Run-Even-Sim.cmd.'
      : `Control server ready (${info.version ?? 'unknown'})`;
  } catch {
    publishLog.textContent = 'Control server not reachable. Run Run-Even-Sim.cmd.';
  }
  try {
    const r = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' });
    const b = (await r.json().catch(() => null)) as { config?: { git?: { deployed?: boolean } } } | null;
    state.deployed = !!b?.config?.git?.deployed;
  } catch { state.deployed = false; }
}

// ── Wire interactions ─────────────────────────────────────────────────────────

function wireInteractions(): void {
  loadVideoBtn.addEventListener('click', () => void loadVideo());
  videoUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void loadVideo(); });
  browseVideoBtn.addEventListener('click', () => videoFileInput.click());
  videoFileInput.addEventListener('change', () => {
    const file = videoFileInput.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    stopFrameCapture();
    state.video = { inputUrl: file.name, embedUrl: objectUrl, platform: 'direct', loaded: true };
    videoUrlInput.value = '';
    persistUserSettings();
    if (bridge) void setupGlassesPage(true);
    render();
    startFrameCapture();
    videoFileInput.value = '';
  });
  clearVideoBtn.addEventListener('click', () => clearVideo());

  fpsInput.addEventListener('change', () => {
    state.userSettings.fps = clampFps(Number(fpsInput.value));
    fpsInput.value = String(state.userSettings.fps);
    persistUserSettings();
    if (frameIntervalId !== null) startFrameCapture(); // restart at new rate
    updateGlassesStatus();
  });

  autoplayToggle.addEventListener('change', () => { state.userSettings.autoplay = autoplayToggle.checked; persistUserSettings(); });
  showKeyToggle.addEventListener('change', () => {
    state.userSettings.showControlsKey = showKeyToggle.checked;
    persistUserSettings();
    if (bridge && imageContainerActive) void setupGlassesPage(true);
  });
  mutedToggle.addEventListener('change', () => {
    state.userSettings.muted = mutedToggle.checked;
    if (state.video.platform === 'direct') videoEl.muted = mutedToggle.checked;
    persistUserSettings();
  });

  // Sliders ─────────────────────────────────────────────────────────────────
  brightnessSlider.addEventListener('input', () => {
    state.userSettings.filters.brightness = Number(brightnessSlider.value);
    brightnessVal.textContent = brightnessSlider.value;
    onFiltersChanged();
  });
  contrastSlider.addEventListener('input', () => {
    state.userSettings.filters.contrast = Number(contrastSlider.value);
    contrastVal.textContent = contrastSlider.value;
    onFiltersChanged();
  });
  zoomSlider.addEventListener('input', () => {
    state.userSettings.filters.zoom = Number(zoomSlider.value);
    zoomVal.textContent = `${Number(zoomSlider.value).toFixed(2)}×`;
    onFiltersChanged();
  });
  panxSlider.addEventListener('input', () => {
    state.userSettings.filters.panX = Number(panxSlider.value);
    panxVal.textContent = panxSlider.value;
    onFiltersChanged();
  });
  panySlider.addEventListener('input', () => {
    state.userSettings.filters.panY = Number(panySlider.value);
    panyVal.textContent = panySlider.value;
    onFiltersChanged();
  });
  invertToggle.addEventListener('change', () => {
    state.userSettings.filters.invert = invertToggle.checked;
    onFiltersChanged();
  });
  imgSmallBtn.addEventListener('click', () => {
    state.userSettings.filters.imgBig = false;
    updateSliderDisplays();
    updateHudPreviewLayout();
    if (bridge && imageContainerActive) void setupGlassesPage(true);
    persistUserSettings();
  });
  imgBigBtn.addEventListener('click', () => {
    state.userSettings.filters.imgBig = true;
    updateSliderDisplays();
    updateHudPreviewLayout();
    if (bridge && imageContainerActive) void setupGlassesPage(true);
    persistUserSettings();
  });

  // Reset-on-click labels ───────────────────────────────────────────────────
  document.querySelectorAll<HTMLButtonElement>('button.slider-lbl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const defaultVal = btn.dataset.default ?? '0';
      const slider = targetId ? document.querySelector<HTMLInputElement>(`#${targetId}`) : null;
      if (!slider) return;
      slider.value = defaultVal;
      slider.dispatchEvent(new Event('input'));
    });
  });

  publishBtn.addEventListener('click', () => void publishApp());
  ehpkBtn.addEventListener('click', () => void buildEhpk());

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      debugToolsVisible = !debugToolsVisible;
      debugToolsFieldset.style.display = debugToolsVisible ? '' : 'none';
      return;
    }
    // Keyboard fallback: simulate glasses button presses for browser testing
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Enter') { e.preventDefault(); handleHubEvent({ sysEvent: { eventType: 0 } }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); handleHubEvent({ sysEvent: { eventType: 1 } }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); handleHubEvent({ sysEvent: { eventType: 2 } }); }
    else if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); handleHubEvent({ sysEvent: { eventType: 3 } }); }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  loadUserSettings();
  syncAllInputs();
  wireInteractions();
  await resolveControlUrl();
  await initControlHealth();
  await initBridge();
  render();
}

void init();
