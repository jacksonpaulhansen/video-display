import './style.css';
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

type InputAction = 'CLICK' | 'UP' | 'DOWN' | 'DOUBLE_CLICK';
type NavigationScope = 'SECTION_LIST' | 'DETAIL';
type PublishStatus = 'IDLE' | 'RUNNING' | 'PACKING' | 'DONE' | 'FAILED';

const SETTINGS_SECTIONS = [
  'HOME',
  'DEVICE_INFO',
  'DISPLAY_HUD',
  'MENU_EDITOR',
  'MIC_TEST',
  'IMU_VIEWER',
  'CONNECTION_HELP',
  'APP_PREFERENCES',
  'ABOUT_EXIT',
] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

type MenuPreferenceItem = {
  id: string;
  label: string;
  enabled: boolean;
};

type PreferencesState = {
  showConnectionTips: boolean;
  compactHud: boolean;
  headsUpEnabled: boolean;
  autoDisplayEnabled: boolean;
  brightnessLevel: number;
  menuItems: MenuPreferenceItem[];
};

type ImuVector = {
  x: number;
  y: number;
  z: number;
};

type SettingsState = {
  sectionIndex: number;
  navigationScope: NavigationScope;
  detailIndex: number;
  micActive: boolean;
  imuActive: boolean;
  imuPaceIndex: number;
  imuVector: ImuVector | null;
  menuEditorIndex: number;
};

type DeviceSnapshot = {
  connectionState: 'CONNECTED' | 'DISCONNECTED';
  glassesBatteryPct: number | null;
  ringBatteryPct: number | null;
  wearing: boolean | null;
  charging: boolean | null;
  inCase: boolean | null;
  model: string;
  serial: string;
  firmware: string;
  userName: string;
  uid: string;
  country: string;
};

type CapabilityState = {
  bridgeConnected: boolean;
  hasDeviceInfo: boolean;
  hasUserInfo: boolean;
  micAvailable: boolean;
  imuAvailable: boolean;
  canExit: boolean;
  canPersistBridgeStorage: boolean;
};

type AppState = {
  publishStatus: PublishStatus;
  deployed: boolean;
  lastAction: string;
  settings: SettingsState;
  preferences: PreferencesState;
  device: DeviceSnapshot;
  capabilities: CapabilityState;
};

type SectionControl = {
  label: string;
  disabled?: boolean;
};

type SectionView = {
  title: string;
  lines: string[];
  controls: SectionControl[];
};

type BridgeExtras = EvenAppBridge & {
  getDeviceInfo?: () => Promise<unknown>;
  getUserInfo?: () => Promise<unknown>;
  onDeviceStatusChanged?: (callback: (payload: unknown) => void) => void;
  audioControl?: (enabled: boolean) => Promise<unknown>;
  imuControl?: (enabled: boolean, pace?: unknown) => Promise<unknown>;
  shutDownPageContainer?: (confirmMode: number) => Promise<unknown>;
  getLocalStorage?: (key: string) => Promise<unknown>;
  setLocalStorage?: (key: string, value: string) => Promise<unknown>;
};

const SECTIONS_CONTAINER_ID = 1;
const SECTIONS_CONTAINER_NAME = 'sectionsText';
const DETAILS_CONTAINER_ID = 2;
const DETAILS_CONTAINER_NAME = 'detailsText';
const CONTROL_URL = 'http://127.0.0.1:8787';
const REQUIRED_CONTROL_CAPABILITY = 'publish-app';
const DISPLAY_WIDTH = 576;
const MAIN_PANEL_X = 24;
const MAIN_PANEL_WIDTH = 528;
const HUD_COLUMN_GAP = 8;
const LEFT_PANEL_WIDTH = 180;
const RIGHT_PANEL_X = MAIN_PANEL_X + LEFT_PANEL_WIDTH + HUD_COLUMN_GAP;
const RIGHT_PANEL_WIDTH = MAIN_PANEL_WIDTH - LEFT_PANEL_WIDTH - HUD_COLUMN_GAP;
const HIDE_DEBUG_TOOLS = true;
const DEV_TOOLS_TOGGLE_SHORTCUT = 'Ctrl+Shift+D';
const MAX_APP_NAME_LENGTH = 20;
const BROWSER_STORAGE_KEY = 'even-g2-settings:v1';
const BRIDGE_STORAGE_KEY = 'even-g2-settings:v1';
const IMU_PACE_OPTIONS = ['P100', 'P200', 'P300', 'P400', 'P500', 'P600', 'P700', 'P800', 'P900', 'P1000'] as const;

const state: AppState = {
  publishStatus: 'IDLE',
  deployed: false,
  lastAction: 'Ready',
  settings: {
    sectionIndex: 0,
    navigationScope: 'SECTION_LIST',
    detailIndex: 0,
    micActive: false,
    imuActive: false,
    imuPaceIndex: 4,
    imuVector: null,
    menuEditorIndex: 0,
  },
  preferences: {
    showConnectionTips: true,
    compactHud: false,
    headsUpEnabled: true,
    autoDisplayEnabled: false,
    brightnessLevel: 7,
    menuItems: [],
  },
  device: {
    connectionState: 'DISCONNECTED',
    glassesBatteryPct: null,
    ringBatteryPct: null,
    wearing: null,
    charging: null,
    inCase: null,
    model: 'Unknown',
    serial: 'Unknown',
    firmware: 'Unknown',
    userName: 'Unknown',
    uid: 'Unknown',
    country: 'Unknown',
  },
  capabilities: {
    bridgeConnected: false,
    hasDeviceInfo: false,
    hasUserInfo: false,
    micAvailable: false,
    imuAvailable: false,
    canExit: false,
    canPersistBridgeStorage: false,
  },
};

let bridge: EvenAppBridge | null = null;
let startupCreated = false;
let lastResolvedAction: InputAction | null = null;
let lastResolvedActionAt = 0;
let lastEventSignature = '';
let lastEventAt = 0;
let lastEventLabel = '';
let debugToolsVisible = !HIDE_DEBUG_TOOLS;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root element');

function requireElement<T extends Element>(value: T | null, name: string): T {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

app.innerHTML = `
  <main class="hud-shell">
    <fieldset class="group-box">
      <legend>Even G2 Setup</legend>
      <div class="setup-shell">
        <div class="setup-sections">
          <div class="pane-title">Sections</div>
          <div id="setup-sections" class="setup-list"></div>
        </div>
        <div class="setup-detail">
          <div class="pane-title">Detail</div>
          <div id="setup-detail" class="detail-card"></div>
        </div>
      </div>
      <p class="hint">Gesture mapping: Up/Down navigate, Click select/toggle, Double-click back</p>
      <p class="hint">Mic Test + IMU Viewer require connected hardware in this browser/offline mode</p>
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
        <pre id="hud-main-preview" class="hud-preview hud-preview-main"></pre>
        <pre id="hud-detail-preview" class="hud-preview hud-preview-detail"></pre>
      </div>
      <p class="hint">Keyboard simulation: Enter=Click, Arrow Up/Down, D=Double-click</p>
    </fieldset>
  </main>
`;

const setupSectionsRoot = requireElement(document.querySelector<HTMLDivElement>('#setup-sections'), '#setup-sections');
const setupDetailRoot = requireElement(document.querySelector<HTMLDivElement>('#setup-detail'), '#setup-detail');
const hudMainPreview = requireElement(document.querySelector<HTMLPreElement>('#hud-main-preview'), '#hud-main-preview');
const hudDetailPreview = requireElement(document.querySelector<HTMLPreElement>('#hud-detail-preview'), '#hud-detail-preview');
const publishBtn = requireElement(document.querySelector<HTMLButtonElement>('#publish-btn'), '#publish-btn');
const ehpkBtn = requireElement(document.querySelector<HTMLButtonElement>('#ehpk-btn'), '#ehpk-btn');
const debugToolsFieldset = requireElement(document.querySelector<HTMLElement>('#debug-tools'), '#debug-tools');
const publishStatus = requireElement(document.querySelector<HTMLSpanElement>('#publish-status'), '#publish-status');
const eventLog = requireElement(document.querySelector<HTMLPreElement>('#event-log'), '#event-log');
const publishLog = requireElement(document.querySelector<HTMLPreElement>('#publish-log'), '#publish-log');

const eventLines: string[] = [];
const leftPanelLeftPercent = (MAIN_PANEL_X / DISPLAY_WIDTH) * 100;
const leftPanelWidthPercent = (LEFT_PANEL_WIDTH / DISPLAY_WIDTH) * 100;
const rightPanelLeftPercent = (RIGHT_PANEL_X / DISPLAY_WIDTH) * 100;
const rightPanelWidthPercent = (RIGHT_PANEL_WIDTH / DISPLAY_WIDTH) * 100;
hudMainPreview.style.left = `${leftPanelLeftPercent}%`;
hudMainPreview.style.width = `${leftPanelWidthPercent}%`;
hudDetailPreview.style.left = `${rightPanelLeftPercent}%`;
hudDetailPreview.style.width = `${rightPanelWidthPercent}%`;

function asBridgeExtras(): BridgeExtras | null {
  return bridge as BridgeExtras | null;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampAppName(value: string): string {
  return String(value || '').trim().slice(0, MAX_APP_NAME_LENGTH);
}

function sectionLabel(section: SettingsSection): string {
  if (section === 'HOME') return 'Home';
  if (section === 'DEVICE_INFO') return 'Device Info';
  if (section === 'DISPLAY_HUD') return 'Display & HUD';
  if (section === 'MENU_EDITOR') return 'Menu Editor';
  if (section === 'MIC_TEST') return 'Mic Test';
  if (section === 'IMU_VIEWER') return 'IMU (Motions)';
  if (section === 'CONNECTION_HELP') return 'Connection Help';
  if (section === 'APP_PREFERENCES') return 'App Preferences';
  return 'About / Exit';
}

function boolText(value: boolean | null): string {
  if (value === null) return '---';
  return value ? 'yes' : ' no';
}

function pctText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '---';
  return `${Math.round(value)}%`;
}

function safeString(value: unknown, fallback = 'Unknown'): string {
  if (typeof value === 'string') {
    const cleaned = value.trim();
    return cleaned || fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function readNested(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toBoolOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'on' || normalized === 'yes' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'off' || normalized === 'no' || normalized === '0') return false;
  }
  return null;
}

function getCurrentSection(): SettingsSection {
  return SETTINGS_SECTIONS[clampInt(state.settings.sectionIndex, 0, SETTINGS_SECTIONS.length - 1)];
}

function getSectionView(section: SettingsSection): SectionView {
  if (section === 'HOME') {
    const lines = [
      `Connection: ${state.device.connectionState}`,
      `Wearing: ${boolText(state.device.wearing)}     In Case: ${boolText(state.device.inCase)}`,
      `Charging: ${boolText(state.device.charging)}`,
      `Batt Glasses: ${pctText(state.device.glassesBatteryPct)}     Ring: ${pctText(state.device.ringBatteryPct)}`,
    ];
    return {
      title: 'Home',
      lines,
      controls: [
        { label: 'Refresh Device Snapshot', disabled: !state.capabilities.hasDeviceInfo },
        { label: 'Restart Phone Connection (Pending SDK)', disabled: true },
      ],
    };
  }

  if (section === 'DEVICE_INFO') {
    return {
      title: 'Device Info',
      lines: [
        `Model: ${state.device.model}`,
        `Serial: ${state.device.serial}`,
        `Firmware: ${state.device.firmware}`,
        `User: ${state.device.userName}`,
        `UID: ${state.device.uid}`,
        `Country: ${state.device.country}`,
      ],
      controls: [],
    };
  }

  if (section === 'DISPLAY_HUD') {
    return {
      title: 'Display & HUD',
      lines: [
        `Brightness: ${state.preferences.brightnessLevel}/10`,
        `Heads-up Display: ${state.preferences.headsUpEnabled ? 'On' : 'Off'}`,
        `Auto Display Off: ${state.preferences.autoDisplayEnabled ? 'No' : 'Yes'}`,
      ],
      controls: [
        { label: 'Brightness (Pending SDK)', disabled: true },
        { label: 'Toggle Heads-up Display' },
        { label: 'Toggle Auto Display Off' },
      ],
    };
  }

  if (section === 'MENU_EDITOR') {
    return {
      title: 'Menu Editor',
      lines: [
        'SDK cannot read phone launcher menu yet.',
        'Menu edit will be enabled when SDK supports it.',
      ],
      controls: [{ label: 'Pending SDK', disabled: true }],
    };
  }

  if (section === 'MIC_TEST') {
    const unavailable = !state.capabilities.micAvailable;
    return {
      title: 'Mic Test',
      lines: unavailable
        ? ['Hardware required.', 'Connect glasses/ring via Even Hub to enable microphone control.']
        : [
            `Status: ${state.settings.micActive ? 'Capturing audio' : 'Idle'}`,
            'PCM stream: 16kHz, signed 16-bit, little-endian, mono.',
          ],
      controls: [{ label: state.settings.micActive ? 'Stop Mic Capture' : 'Start Mic Capture', disabled: unavailable }],
    };
  }

  if (section === 'IMU_VIEWER') {
    const unavailable = !state.capabilities.imuAvailable;
    const vector = state.settings.imuVector;
    return {
      title: 'IMU Viewer',
      lines: unavailable
        ? ['IMU = Inertial Measurement Unit.', 'Hardware required.', 'Connect glasses/ring via Even Hub to enable IMU controls.']
        : [
            'IMU = Inertial Measurement Unit.',
            `Status: ${state.settings.imuActive ? 'Streaming' : 'Idle'}`,
            `Pace: ${IMU_PACE_OPTIONS[state.settings.imuPaceIndex]}`,
            `X: ${vector ? vector.x.toFixed(2) : 'n/a'}`,
            `Y: ${vector ? vector.y.toFixed(2) : 'n/a'}`,
            `Z: ${vector ? vector.z.toFixed(2) : 'n/a'}`,
          ],
      controls: [
        { label: `Cycle Pace (${IMU_PACE_OPTIONS[state.settings.imuPaceIndex]})`, disabled: unavailable },
        { label: state.settings.imuActive ? 'Stop IMU Stream' : 'Start IMU Stream', disabled: unavailable },
      ],
    };
  }

  if (section === 'CONNECTION_HELP') {
    return {
      title: 'Connection Help',
      lines: [
        'If BLE drops: app session ends.',
        'Reconnect is not SDK-controlled.',
        'Glasses restart: tap each temple 5 times rapidly.',
        'Ring restart: place on charger and tap ring touchpad 5 times.',
      ],
      controls: [],
    };
  }

  if (section === 'APP_PREFERENCES') {
    return {
      title: 'App Preferences',
      lines: [
        `Show Connection Tips: ${state.preferences.showConnectionTips ? 'On' : 'Off'}`,
        `Compact HUD: ${state.preferences.compactHud ? 'On' : 'Off'}`,
      ],
      controls: [{ label: 'Toggle Connection Tips' }, { label: 'Toggle Compact HUD' }],
    };
  }

  return {
    title: 'About / Exit',
    lines: [
      'Even G2 Settings App v1',
      `Bridge: ${state.capabilities.bridgeConnected ? 'connected' : 'offline browser mode'}`,
    ],
    controls: [{ label: 'Exit App', disabled: !state.capabilities.canExit }],
  };
}

function controlCount(section: SettingsSection): number {
  return getSectionView(section).controls.length;
}

function clampDetailIndex(): void {
  const section = getCurrentSection();
  const max = Math.max(0, controlCount(section) - 1);
  state.settings.detailIndex = clampInt(state.settings.detailIndex, 0, max);
}

function trimToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function buildSectionsHudText(): string {
  const lines: string[] = ['SECTIONS'];
  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    const item = SETTINGS_SECTIONS[index];
    const isSelected = index === state.settings.sectionIndex;
    const cursor =
      isSelected && state.settings.navigationScope === 'DETAIL'
        ? '▶'
        : state.settings.navigationScope === 'SECTION_LIST' && isSelected
          ? '▷'
          : ' ';
    lines.push(`${cursor} ${sectionLabel(item)}`);
  }
  return lines.map((line) => trimToWidth(line, 28)).join('\n').slice(0, 1900);
}

function buildDetailsHudText(): string {
  const section = getCurrentSection();
  const view = getSectionView(section);
  const lines: string[] = [`${view.title} Details`];
  for (const line of view.lines.slice(0, state.preferences.compactHud ? 4 : 6)) {
    lines.push(`- ${line}`);
  }
  lines.push('');
  if (view.controls.length === 0) {
    lines.push('Controls: none');
  } else {
    lines.push('Controls:');
    for (let index = 0; index < view.controls.length; index += 1) {
      const control = view.controls[index];
      const cursor = state.settings.navigationScope === 'DETAIL' && index === state.settings.detailIndex ? '▷' : ' ';
      const disabled = control.disabled ? ' [disabled]' : '';
      lines.push(`${cursor} ${index + 1}. ${control.label}${disabled}`);
    }
  }
  return lines.map((line) => trimToWidth(line, 52)).join('\n').slice(0, 1900);
}

async function pushHudToEvenHub(): Promise<void> {
  if (!bridge || !startupCreated) return;
  const leftContent = buildSectionsHudText();
  const rightContent = buildDetailsHudText();
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: SECTIONS_CONTAINER_ID,
      containerName: SECTIONS_CONTAINER_NAME,
      contentOffset: 0,
      contentLength: leftContent.length,
      content: leftContent,
    }),
  );
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: DETAILS_CONTAINER_ID,
      containerName: DETAILS_CONTAINER_NAME,
      contentOffset: 0,
      contentLength: rightContent.length,
      content: rightContent,
    }),
  );
}

function renderSetupSections(): void {
  const rows = SETTINGS_SECTIONS.map((section, index) => {
    const isSelected = index === state.settings.sectionIndex;
    const classes = ['setup-list-item'];
    if (isSelected) classes.push('active');
    if (state.settings.navigationScope === 'SECTION_LIST' && isSelected) classes.push('focus');
    return `
      <button type="button" class="${classes.join(' ')}" data-section-index="${index}">
        <span class="idx">${index + 1}</span>
        <span>${sectionLabel(section)}</span>
      </button>
    `;
  });
  setupSectionsRoot.innerHTML = rows.join('');
}

function renderSetupDetail(): void {
  const section = getCurrentSection();
  clampDetailIndex();
  const view = getSectionView(section);
  const lines = view.lines.map((line) => `<div class="detail-line">${line}</div>`).join('');
  const controls = view.controls.length
    ? view.controls
        .map((control, index) => {
          const classes = ['detail-control'];
          if (index === state.settings.detailIndex) classes.push('active');
          if (state.settings.navigationScope === 'DETAIL' && index === state.settings.detailIndex) classes.push('focus');
          return `
            <button
              type="button"
              class="${classes.join(' ')}"
              data-control-index="${index}"
              ${control.disabled ? 'disabled' : ''}
            >
              ${index + 1}. ${control.label}
            </button>
          `;
        })
        .join('')
    : '<div class="detail-empty">No interactive controls for this section.</div>';

  setupDetailRoot.innerHTML = `
    <div class="detail-title">${view.title}</div>
    <div class="detail-lines">${lines}</div>
    <div class="detail-controls">${controls}</div>
  `;
}

async function render(): Promise<void> {
  renderSetupSections();
  renderSetupDetail();
  hudMainPreview.textContent = buildSectionsHudText();
  hudDetailPreview.textContent = buildDetailsHudText();
  publishStatus.textContent = state.publishStatus;
  publishBtn.textContent = state.deployed ? 'Update App' : 'Publish App';
  try {
    await pushHudToEvenHub();
  } catch (error) {
    console.error('Failed to push HUD update to Even Hub:', error);
  }
}

function moveSection(direction: 1 | -1): void {
  const max = SETTINGS_SECTIONS.length;
  state.settings.sectionIndex = (state.settings.sectionIndex + direction + max) % max;
  state.settings.detailIndex = 0;
  state.lastAction = `Section: ${sectionLabel(getCurrentSection())}`;
}

function moveDetail(direction: 1 | -1): void {
  const section = getCurrentSection();
  const total = controlCount(section);
  if (total <= 1) {
    state.lastAction = total === 0 ? 'No controls in this section' : 'Control unchanged';
    return;
  }
  state.settings.detailIndex = (state.settings.detailIndex + direction + total) % total;
  state.lastAction = `Control ${state.settings.detailIndex + 1} selected`;
}

function clampBrightness(value: number): number {
  return clampInt(value, 1, 10);
}

function parseBridgeStoredPrefs(raw: unknown): Partial<PreferencesState> | null {
  const payload =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && raw && 'value' in raw
        ? (raw as { value?: unknown }).value
        : null;
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<PreferencesState>;
    return parsed;
  } catch {
    return null;
  }
}

function normalizedPreferences(input: Partial<PreferencesState>): PreferencesState {
  const sanitizedMenuItems = Array.isArray(input.menuItems)
    ? input.menuItems
        .map((item): MenuPreferenceItem | null => {
          if (!item || typeof item !== 'object') return null;
          const source = item as Partial<MenuPreferenceItem>;
          const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : null;
          const label = typeof source.label === 'string' && source.label.trim() ? source.label.trim() : null;
          if (!id || !label) return null;
          return { id, label, enabled: source.enabled !== false };
        })
        .filter((item): item is MenuPreferenceItem => item !== null)
    : [];

  return {
    showConnectionTips:
      typeof input.showConnectionTips === 'boolean' ? input.showConnectionTips : state.preferences.showConnectionTips,
    compactHud: typeof input.compactHud === 'boolean' ? input.compactHud : state.preferences.compactHud,
    headsUpEnabled: typeof input.headsUpEnabled === 'boolean' ? input.headsUpEnabled : state.preferences.headsUpEnabled,
    autoDisplayEnabled:
      typeof input.autoDisplayEnabled === 'boolean' ? input.autoDisplayEnabled : state.preferences.autoDisplayEnabled,
    brightnessLevel: clampBrightness(typeof input.brightnessLevel === 'number' ? input.brightnessLevel : state.preferences.brightnessLevel),
    menuItems: sanitizedMenuItems.length > 0 ? sanitizedMenuItems : state.preferences.menuItems.map((item) => ({ ...item })),
  };
}

function loadBrowserPreferences(): void {
  try {
    const raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PreferencesState>;
    state.preferences = normalizedPreferences(parsed);
    state.settings.menuEditorIndex = clampInt(state.settings.menuEditorIndex, 0, Math.max(0, state.preferences.menuItems.length - 1));
  } catch {
    state.lastAction = 'Browser preferences unreadable; using defaults';
  }
}

function persistBrowserPreferences(): void {
  window.localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(state.preferences));
}

async function loadBridgePreferences(): Promise<void> {
  const b = asBridgeExtras();
  if (!b?.getLocalStorage) return;
  try {
    const raw = await b.getLocalStorage(BRIDGE_STORAGE_KEY);
    const parsed = parseBridgeStoredPrefs(raw);
    if (!parsed) return;

    state.preferences = normalizedPreferences(parsed);
    state.settings.menuEditorIndex = clampInt(state.settings.menuEditorIndex, 0, Math.max(0, state.preferences.menuItems.length - 1));
  } catch {
    state.lastAction = 'Bridge preferences unavailable';
  }
}

async function persistBridgePreferences(): Promise<void> {
  const b = asBridgeExtras();
  if (!b?.setLocalStorage) return;
  try {
    await b.setLocalStorage(BRIDGE_STORAGE_KEY, JSON.stringify(state.preferences));
  } catch {
    state.lastAction = 'Failed to sync preferences to bridge';
  }
}

async function persistPreferences(): Promise<void> {
  persistBrowserPreferences();
  await persistBridgePreferences();
}

async function refreshDeviceSnapshot(): Promise<void> {
  const b = asBridgeExtras();
  if (!b) {
    state.device.connectionState = 'DISCONNECTED';
    state.lastAction = 'Bridge unavailable';
    return;
  }

  try {
    if (b.getDeviceInfo) {
      const info = await b.getDeviceInfo();
      if (typeof info === 'object' && info) {
        const root = info as unknown as Record<string, unknown>;
        const glasses = (root.glasses ?? root.glassesInfo ?? root.device ?? null) as Record<string, unknown> | null;
        const ring = (root.ring ?? root.ringInfo ?? null) as Record<string, unknown> | null;
        state.device.glassesBatteryPct = toNumberOrNull(
          readNested(root, ['glassesBattery', 'battery', 'batteryLevel', 'batteryPct']) ??
            (glasses ? readNested(glasses, ['battery', 'batteryLevel', 'batteryPct']) : null),
        );
        state.device.ringBatteryPct = toNumberOrNull(
          readNested(root, ['ringBattery']) ?? (ring ? readNested(ring, ['battery', 'batteryLevel', 'batteryPct']) : null),
        );
        state.device.wearing = toBoolOrNull(readNested(root, ['wearing', 'wearingStatus', 'isWearing']));
        state.device.charging = toBoolOrNull(readNested(root, ['charging', 'chargingStatus', 'isCharging']));
        state.device.inCase = toBoolOrNull(readNested(root, ['inCase', 'inCaseStatus', 'isInCase']));
        state.device.model = safeString(readNested(root, ['model', 'deviceModel', 'glassesModel']), state.device.model);
        state.device.serial = safeString(readNested(root, ['serial', 'serialNumber', 'sn']), state.device.serial);
        state.device.firmware = safeString(readNested(root, ['firmware', 'firmwareVersion', 'fw']), state.device.firmware);
      }
    }

    if (b.getUserInfo) {
      const user = await b.getUserInfo();
      if (typeof user === 'object' && user) {
        const userObj = user as unknown as Record<string, unknown>;
        state.device.userName = safeString(readNested(userObj, ['name', 'nickname', 'displayName']), state.device.userName);
        state.device.uid = safeString(readNested(userObj, ['uid', 'userId', 'id']), state.device.uid);
        state.device.country = safeString(readNested(userObj, ['country', 'region']), state.device.country);
      }
    }
    state.device.connectionState = 'CONNECTED';
    state.lastAction = 'Device snapshot refreshed';
  } catch {
    state.device.connectionState = 'DISCONNECTED';
    state.lastAction = 'Device snapshot refresh failed';
  }
}

function updateCapabilitiesFromBridge(): void {
  const b = asBridgeExtras();
  state.capabilities.bridgeConnected = !!b;
  state.capabilities.hasDeviceInfo = !!b?.getDeviceInfo;
  state.capabilities.hasUserInfo = !!b?.getUserInfo;
  state.capabilities.micAvailable = !!b?.audioControl;
  state.capabilities.imuAvailable = !!b?.imuControl;
  state.capabilities.canExit = !!b?.shutDownPageContainer;
  state.capabilities.canPersistBridgeStorage = !!b?.getLocalStorage && !!b?.setLocalStorage;
  state.device.connectionState = b ? 'CONNECTED' : 'DISCONNECTED';
}

async function toggleMic(): Promise<void> {
  const b = asBridgeExtras();
  if (!b?.audioControl || !state.capabilities.micAvailable) {
    state.lastAction = 'Mic control requires connected hardware';
    return;
  }
  const next = !state.settings.micActive;
  try {
    await b.audioControl(next);
    state.settings.micActive = next;
    state.lastAction = next ? 'Mic capture started' : 'Mic capture stopped';
  } catch {
    state.lastAction = 'Mic operation failed';
  }
}

function mapPaceToken(token: string): unknown {
  return token;
}

async function toggleImu(): Promise<void> {
  const b = asBridgeExtras();
  if (!b?.imuControl || !state.capabilities.imuAvailable) {
    state.lastAction = 'IMU control requires connected hardware';
    return;
  }
  const next = !state.settings.imuActive;
  try {
    if (next) {
      const paceToken = IMU_PACE_OPTIONS[state.settings.imuPaceIndex];
      await b.imuControl(true, mapPaceToken(paceToken));
    } else {
      await b.imuControl(false);
    }
    state.settings.imuActive = next;
    state.lastAction = next ? 'IMU streaming started' : 'IMU streaming stopped';
  } catch {
    state.lastAction = 'IMU operation failed';
  }
}

function cycleImuPace(): void {
  state.settings.imuPaceIndex = (state.settings.imuPaceIndex + 1) % IMU_PACE_OPTIONS.length;
  state.lastAction = `IMU pace: ${IMU_PACE_OPTIONS[state.settings.imuPaceIndex]}`;
}

async function exitApp(): Promise<void> {
  const b = asBridgeExtras();
  if (!b?.shutDownPageContainer) {
    state.lastAction = 'Exit requires connected hardware';
    return;
  }
  try {
    await b.shutDownPageContainer(1);
    state.lastAction = 'Exit requested';
  } catch {
    state.lastAction = 'Exit request failed';
  }
}

function appendEventLog(line: string): void {
  eventLines.push(line);
  while (eventLines.length > 8) {
    eventLines.shift();
  }
  eventLog.textContent = eventLines.join('\n');
}

function mapEventTypeToAction(eventType: unknown): InputAction | null {
  if (eventType === undefined || eventType === null) return null;

  const normalized = OsEventTypeList.fromJson?.(eventType);
  if (normalized === OsEventTypeList.CLICK_EVENT) return 'CLICK';
  if (normalized === OsEventTypeList.SCROLL_TOP_EVENT) return 'UP';
  if (normalized === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'DOWN';
  if (normalized === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'DOUBLE_CLICK';

  if (eventType === OsEventTypeList.CLICK_EVENT || eventType === 0) return 'CLICK';
  if (eventType === OsEventTypeList.SCROLL_TOP_EVENT || eventType === 1) return 'UP';
  if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT || eventType === 2) return 'DOWN';
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT || eventType === 3) return 'DOUBLE_CLICK';

  const text = String(eventType).toUpperCase();
  if (text.includes('DOUBLE') && text.includes('CLICK')) return 'DOUBLE_CLICK';
  if (text.includes('DOUBLE') && text.includes('TAP')) return 'DOUBLE_CLICK';
  if (text.includes('SCROLL_TOP') || text === 'UP' || text.includes('SWIPE_UP')) return 'UP';
  if (text.includes('SCROLL_BOTTOM') || text === 'DOWN' || text.includes('SWIPE_DOWN')) return 'DOWN';
  if (text.includes('SINGLE') && text.includes('CLICK')) return 'CLICK';
  if (text.includes('SINGLE') && text.includes('TAP')) return 'CLICK';
  if (text.includes('TAP_EVENT') || text === 'TAP') return 'CLICK';
  if (text === 'CLICK' || text.includes('CLICK_EVENT')) return 'CLICK';

  return null;
}

function extractEventType(event: unknown): unknown {
  const input = event as Record<string, unknown> | null | undefined;
  if (!input) return null;
  const listEvent = (input.listEvent ?? null) as Record<string, unknown> | null;
  const textEvent = (input.textEvent ?? null) as Record<string, unknown> | null;
  const sysEvent = (input.sysEvent ?? null) as Record<string, unknown> | null;
  return (
    listEvent?.eventType ??
    textEvent?.eventType ??
    sysEvent?.eventType ??
    listEvent?.eventName ??
    textEvent?.eventName ??
    sysEvent?.eventName ??
    listEvent?.type ??
    textEvent?.type ??
    sysEvent?.type ??
    input.eventType ??
    input.type ??
    input.name
  );
}

function shouldTreatEmptySysEventAsClick(event: unknown): boolean {
  const explicitType = extractEventType(event);
  if (mapEventTypeToAction(explicitType)) return false;

  const now = Date.now();
  if (lastResolvedAction === 'DOUBLE_CLICK' && now - lastResolvedActionAt < 350) return false;
  return true;
}

function isDuplicateEvent(event: unknown, eventLabel: string): boolean {
  const payload = event as Record<string, unknown> | null | undefined;
  const signature = JSON.stringify({
    listEvent: payload?.listEvent ?? null,
    textEvent: payload?.textEvent ?? null,
    sysEvent: payload?.sysEvent ?? null,
    eventType: payload?.eventType ?? null,
    type: payload?.type ?? null,
  });

  const now = Date.now();
  if (eventLabel === lastEventLabel && signature === lastEventSignature && now - lastEventAt < 140) {
    return true;
  }

  lastEventLabel = eventLabel;
  lastEventSignature = signature;
  lastEventAt = now;
  return false;
}

function extractImuVector(event: unknown): ImuVector | null {
  const payload = event as Record<string, unknown> | null | undefined;
  if (!payload) return null;

  const imuRoot = (payload.imuEvent ?? payload.imuData ?? payload.imu ?? payload.motion ?? null) as
    | Record<string, unknown>
    | null;
  if (!imuRoot) return null;

  const x = toNumberOrNull(readNested(imuRoot, ['x', 'axisX', 'pitch']));
  const y = toNumberOrNull(readNested(imuRoot, ['y', 'axisY', 'roll']));
  const z = toNumberOrNull(readNested(imuRoot, ['z', 'axisZ', 'yaw']));
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

async function activateDetailControl(section: SettingsSection): Promise<void> {
  const controlIndex = state.settings.detailIndex;

  if (section === 'HOME') {
    if (controlIndex === 0) await refreshDeviceSnapshot();
    return;
  }

  if (section === 'DEVICE_INFO') {
    if (controlIndex === 0) await refreshDeviceSnapshot();
    return;
  }

  if (section === 'MIC_TEST') {
    if (controlIndex === 0) await toggleMic();
    return;
  }

  if (section === 'IMU_VIEWER') {
    if (controlIndex === 0) {
      cycleImuPace();
      return;
    }
    if (controlIndex === 1) {
      await toggleImu();
    }
    return;
  }

  if (section === 'DISPLAY_HUD') {
    if (controlIndex === 0) {
      state.lastAction = 'Brightness control pending SDK support';
      return;
    }
    if (controlIndex === 1) state.preferences.headsUpEnabled = !state.preferences.headsUpEnabled;
    if (controlIndex === 2) state.preferences.autoDisplayEnabled = !state.preferences.autoDisplayEnabled;
    await persistPreferences();
    if (controlIndex === 1) {
      state.lastAction = `Heads-up display: ${state.preferences.headsUpEnabled ? 'on' : 'off'}`;
    }
    if (controlIndex === 2) {
      state.lastAction = `Auto display: ${state.preferences.autoDisplayEnabled ? 'on' : 'off'}`;
    }
    return;
  }

  if (section === 'MENU_EDITOR') {
    state.lastAction = 'Menu editor pending SDK support';
    return;
  }

  if (section === 'APP_PREFERENCES') {
    if (controlIndex === 0) state.preferences.showConnectionTips = !state.preferences.showConnectionTips;
    if (controlIndex === 1) state.preferences.compactHud = !state.preferences.compactHud;
    await persistPreferences();
    state.lastAction = 'Preferences updated';
    return;
  }

  if (section === 'ABOUT_EXIT' && controlIndex === 0) {
    await exitApp();
    return;
  }

  state.lastAction = 'No action for this control';
}

async function applyAction(action: InputAction): Promise<void> {
  const section = getCurrentSection();
  const view = getSectionView(section);

  if (state.settings.navigationScope === 'SECTION_LIST') {
    if (action === 'UP') moveSection(-1);
    if (action === 'DOWN') moveSection(1);
    if (action === 'CLICK') {
      state.settings.navigationScope = 'DETAIL';
      state.settings.detailIndex = 0;
      state.lastAction = `Detail mode: ${view.title}`;
    }
    if (action === 'DOUBLE_CLICK') {
      state.lastAction = 'Already at section list';
    }
    await render();
    return;
  }

  if (action === 'UP') moveDetail(-1);
  if (action === 'DOWN') moveDetail(1);
  if (action === 'CLICK') {
    clampDetailIndex();
    const selected = getSectionView(section).controls[state.settings.detailIndex];
    if (selected?.disabled) {
      state.lastAction = 'Control disabled in offline mode';
    } else {
      await activateDetailControl(section);
    }
  }
  if (action === 'DOUBLE_CLICK') {
    state.settings.navigationScope = 'SECTION_LIST';
    state.settings.detailIndex = 0;
    state.lastAction = 'Back to sections';
  }
  await render();
}

async function createStartupPage(): Promise<void> {
  if (!bridge) return;
  const leftContent = buildSectionsHudText();
  const rightContent = buildDetailsHudText();
  const containerPayload = {
    containerTotalNum: 2,
    textObject: [
      new TextContainerProperty({
        xPosition: MAIN_PANEL_X,
        yPosition: 0,
        width: LEFT_PANEL_WIDTH,
        height: 288,
        containerID: SECTIONS_CONTAINER_ID,
        containerName: SECTIONS_CONTAINER_NAME,
        content: leftContent,
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: RIGHT_PANEL_X,
        yPosition: 0,
        width: RIGHT_PANEL_WIDTH,
        height: 288,
        containerID: DETAILS_CONTAINER_ID,
        containerName: DETAILS_CONTAINER_NAME,
        content: rightContent,
        isEventCapture: 0,
      }),
    ],
  };

  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containerPayload));
  startupCreated = result === 0;
  if (startupCreated) return;

  console.warn('createStartUpPageContainer failed with code:', result, 'trying rebuildPageContainer...');
  const rebuildOk = await bridge.rebuildPageContainer(new RebuildPageContainer(containerPayload));
  startupCreated = !!rebuildOk;
  if (!startupCreated) {
    console.warn('rebuildPageContainer also failed');
  }
}

async function publishApp(): Promise<void> {
  if (state.publishStatus === 'RUNNING') {
    publishLog.textContent = 'Publish is already running. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configResponse?.json().catch(() => null)) as
    | { config?: { appName?: string; github?: { repo?: string } } }
    | null;

  const savedRepoName = (configBody?.config?.github?.repo ?? '').trim();
  const defaultAppName = clampAppName(savedRepoName || configBody?.config?.appName || 'even-g2-settings');
  let appName = defaultAppName;

  if (!savedRepoName) {
    const appNameInput = window.prompt(`App name (max ${MAX_APP_NAME_LENGTH} chars):`, defaultAppName);
    appName = clampAppName(appNameInput ?? '');
    if (!appName) {
      publishLog.textContent = 'Publish cancelled: app name is required.';
      await render();
      return;
    }
  }

  state.publishStatus = 'RUNNING';
  publishBtn.disabled = true;
  ehpkBtn.disabled = true;
  publishLog.textContent = `Publishing "${appName}"...`;
  await render();

  try {
    let response = await fetch(`${CONTROL_URL}/publish-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName }),
    });

    let body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; code?: string; publishUrl?: string }
      | null;

    if (!response.ok && (body?.code === 'PAT_REQUIRED' || body?.code === 'INVALID_PAT')) {
      const promptText =
        body?.code === 'INVALID_PAT'
          ? 'Saved PAT is invalid. Paste a new GitHub PAT:'
          : 'GitHub PAT required. Paste PAT:';
      const pat = window.prompt(promptText);
      if (!pat || !pat.trim()) {
        throw new Error('Publish cancelled: PAT is required.');
      }
      response = await fetch(`${CONTROL_URL}/publish-app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName, pat: pat.trim() }),
      });
      body = (await response.json().catch(() => null)) as
        | { error?: string; logs?: string; publishUrl?: string }
        | null;
    }

    if (!response.ok) {
      if (response.status === 409) {
        state.publishStatus = 'RUNNING';
        publishLog.textContent = 'Publish already running. Please wait for it to complete.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
    state.deployed = true;
    publishLog.textContent = `${body?.logs ?? 'Publish complete.'}\n\nPublished URL:\n${body?.publishUrl ?? 'unknown'}`;
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

async function buildEhpk(): Promise<void> {
  if (state.publishStatus === 'RUNNING' || state.publishStatus === 'PACKING') {
    publishLog.textContent = 'Another operation is in progress. Please wait...';
    await render();
    return;
  }

  const configResponse = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' }).catch(() => null);
  const configBody = (await configResponse?.json().catch(() => null)) as { config?: { appName?: string } } | null;
  const defaultAppName = clampAppName((configBody?.config?.appName ?? 'even-g2-settings').trim() || 'even-g2-settings');

  const appNameInput = window.prompt(`App name for .ehpk package (max ${MAX_APP_NAME_LENGTH} chars):`, defaultAppName);
  const appName = clampAppName(appNameInput ?? '');
  if (!appName) {
    publishLog.textContent = 'Build cancelled: app name is required.';
    await render();
    return;
  }

  state.publishStatus = 'PACKING';
  publishBtn.disabled = true;
  ehpkBtn.disabled = true;
  publishLog.textContent = `Building .ehpk for "${appName}"...`;
  await render();

  try {
    const response = await fetch(`${CONTROL_URL}/build-ehpk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName }),
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; logs?: string; outputPath?: string }
      | null;

    if (!response.ok) {
      if (response.status === 409) {
        state.publishStatus = 'PACKING';
        publishLog.textContent = 'EHPK build already running. Please wait for it to finish.';
        await render();
        return;
      }
      throw new Error(body?.error ?? `HTTP ${response.status}`);
    }

    state.publishStatus = 'DONE';
    publishLog.textContent = `${body?.logs ?? 'EHPK build complete.'}\n\nOutput:\n${body?.outputPath ?? 'unknown'}`;
  } catch (error) {
    state.publishStatus = 'FAILED';
    publishLog.textContent = `Error: ${String(error)}`;
  } finally {
    publishBtn.disabled = false;
    ehpkBtn.disabled = false;
    await render();
  }
}

function setKeyboardFallback(): void {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      debugToolsVisible = !debugToolsVisible;
      debugToolsFieldset.style.display = debugToolsVisible ? '' : 'none';
      console.log(`[debug-tools] ${debugToolsVisible ? 'shown' : 'hidden'} (${DEV_TOOLS_TOGGLE_SHORTCUT})`);
      return;
    }

    if (event.key === 'Enter') return void applyAction('CLICK');
    if (event.key === 'ArrowUp') return void applyAction('UP');
    if (event.key === 'ArrowDown') return void applyAction('DOWN');
    if (event.key.toLowerCase() === 'd') return void applyAction('DOUBLE_CLICK');
  });
}

function wireBrowserSetupInteractions(): void {
  setupSectionsRoot.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-section-index]');
    if (!button) return;
    const index = Number(button.dataset.sectionIndex);
    state.settings.sectionIndex = clampInt(index, 0, SETTINGS_SECTIONS.length - 1);
    state.settings.navigationScope = 'SECTION_LIST';
    state.settings.detailIndex = 0;
    state.lastAction = `Section: ${sectionLabel(getCurrentSection())}`;
    void render();
  });

  setupDetailRoot.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('[data-control-index]');
    if (!button) return;
    const index = Number(button.dataset.controlIndex);
    state.settings.navigationScope = 'DETAIL';
    state.settings.detailIndex = Math.max(0, index);
    void applyAction('CLICK');
  });
}

async function initControlHealth(): Promise<void> {
  try {
    const health = await fetch(`${CONTROL_URL}/health`, { cache: 'no-store' });
    const info = (await health.json().catch(() => null)) as { capabilities?: string[]; version?: string } | null;
    if (!health.ok || !info?.capabilities?.includes(REQUIRED_CONTROL_CAPABILITY)) {
      publishLog.textContent = 'Control server is outdated. Run Run-Even-Sim.cmd to refresh local services.';
    } else {
      publishLog.textContent = `Control server ready (${info.version ?? 'unknown'})`;
    }
  } catch {
    publishLog.textContent = 'Control server not reachable. Run Run-Even-Sim.cmd.';
  }

  try {
    const response = await fetch(`${CONTROL_URL}/config`, { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as { config?: { git?: { deployed?: boolean } } } | null;
    state.deployed = !!body?.config?.git?.deployed;
  } catch {
    state.deployed = false;
  }
}

async function initBridge(): Promise<void> {
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Even bridge timeout')), 5000)),
    ]);

    updateCapabilitiesFromBridge();
    await createStartupPage();
    await loadBridgePreferences();
    await persistBridgePreferences();
    await refreshDeviceSnapshot();

    const b = asBridgeExtras();
    if (b?.onDeviceStatusChanged) {
      b.onDeviceStatusChanged(() => {
        void refreshDeviceSnapshot().then(() => render());
      });
    }

    const handleHubEvent = (event: unknown) => {
      const vector = extractImuVector(event);
      if (vector) {
        state.settings.imuVector = vector;
        if (state.settings.imuActive) {
          void render();
        }
      }

      const eventType = extractEventType(event);
      let action = mapEventTypeToAction(eventType);
      const payload = event as Record<string, unknown> | null | undefined;
      if (!action && payload?.textEvent && !payload?.listEvent && !payload?.sysEvent) {
        action = 'CLICK';
      }
      if (!action && shouldTreatEmptySysEventAsClick(event)) {
        action = 'CLICK';
      }

      const eventLabel = action ?? 'NONE';
      if (isDuplicateEvent(event, eventLabel)) return;
      appendEventLog(`${new Date().toLocaleTimeString()}  ${eventLabel}`);
      if (action) {
        lastResolvedAction = action;
        lastResolvedActionAt = Date.now();
        console.log('[hub-event]', { action, eventType, event });
        void applyAction(action);
      }
    };

    bridge.onEvenHubEvent((event) => {
      handleHubEvent(event);
    });

    window.addEventListener('evenHubEvent', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      handleHubEvent(detail);
    });
  } catch (error) {
    console.warn('Even bridge not ready, using browser fallback mode:', error);
    bridge = null;
    updateCapabilitiesFromBridge();
  }
}

async function init(): Promise<void> {
  loadBrowserPreferences();
  setKeyboardFallback();
  wireBrowserSetupInteractions();

  publishBtn.addEventListener('click', () => void publishApp());
  ehpkBtn.addEventListener('click', () => void buildEhpk());

  await initControlHealth();
  await initBridge();
  await render();
}

void init();
