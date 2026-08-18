import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostService } from './host-service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARED_DOWNLOAD_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
const APP_USER_MODEL_ID = 'dev.discordy.desktop';

const MAX_DEEP_LINK_LENGTH = 4096;
const MAX_CLIPBOARD_TEXT_LENGTH = 64 * 1024;
const ALLOWED_INVITE_TTL_MINUTES = new Set([15, 30, 60, 360, 1440]);
const ROOM_ID_RE = /^[A-Z0-9_-]{1,20}$/;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{40,128}$/;

const DEFAULT_DESKTOP_PREFERENCES = Object.freeze({
  minimizeToTray: true,
  closeToTray: true,
  notifications: true,
  launchAtStartup: false,
  globalShortcuts: true,
});

let mainWindow = null;
let tray = null;
let pendingDeepLink = null;
let pendingDisplaySelection = null;
let isQuitting = false;
let preferencesPath = null;
let desktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES };
let globalKeyMonitor = null;
let globalKeyMonitorBuffer = '';
let trayHintShown = false;
let trayMediaState = { micEnabled: true, deafened: false };
let shortcutStatus = {
  mute: false,
  deafen: false,
  toggleWindow: false,
  holdKeys: false,
};

let updaterInstance = null;
let updateState = {
  supported: false,
  status: 'unsupported',
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: null,
  message: 'Atualizações automáticas disponíveis somente no instalador NSIS.',
  error: null,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
};

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

const hostService = new HostService({
  logger: (line) => sendToRenderer('host:log', line),
  onStatus: (status) => sendToRenderer('host:status', status),
});

function getDesktopExecutablePath() {
  return process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE
    ? process.env.PORTABLE_EXECUTABLE_FILE
    : process.execPath;
}

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('discordy', process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient('discordy', getDesktopExecutablePath());
  }
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function normalizeDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_DEEP_LINK_LENGTH) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'discordy:' || url.hostname !== 'join' || url.username || url.password) return null;
  const allowedKeys = new Set(['server', 'room', 'token', 'v']);
  for (const key of url.searchParams.keys()) if (!allowedKeys.has(key)) return null;
  const roomId = String(url.searchParams.get('room') || '').toUpperCase();
  const token = String(url.searchParams.get('token') || '');
  const version = String(url.searchParams.get('v') || '2');
  if (!ROOM_ID_RE.test(roomId) || !INVITE_TOKEN_RE.test(token) || version !== '2') return null;
  let server;
  try { server = new URL(String(url.searchParams.get('server') || '')); } catch { return null; }
  if (server.username || server.password || server.pathname !== '/' || server.search || server.hash) return null;
  const secureRemote = server.protocol === 'https:';
  const localHttp = server.protocol === 'http:' && isLoopbackHostname(server.hostname);
  if (!secureRemote && !localHttp) return null;
  url.search = '';
  url.searchParams.set('server', server.origin);
  url.searchParams.set('room', roomId);
  url.searchParams.set('token', token);
  url.searchParams.set('v', '2');
  return url.toString();
}

function extractDeepLink(args) {
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.toLowerCase().startsWith('discordy://')) continue;
    const normalized = normalizeDeepLink(arg);
    if (normalized) return normalized;
  }
  return null;
}

function isTrustedRendererUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const current = new URL(rawUrl);
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) return current.origin === new URL(devUrl).origin;
    if (current.protocol !== 'file:') return false;
    return fileURLToPath(current) === join(__dirname, '..', 'dist', 'index.html');
  } catch {
    return false;
  }
}

function assertTrustedIpc(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) throw new Error('Renderer não autorizado.');
  const frameUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedRendererUrl(frameUrl)) throw new Error('Origem IPC não autorizada.');
}

function normalizeExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function openExternalSafe(raw) {
  const url = normalizeExternalUrl(raw);
  if (!url) return false;
  await shell.openExternal(url);
  return true;
}

function sanitizeHostStartOptions(options = {}) {
  const roomId = String(options.roomId || '').toUpperCase();
  const roomName = String(options.roomName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const maxParticipants = Number(options.maxParticipants);
  const pin = String(options.pin || '').trim();
  const inviteTtlMinutes = Number(options.inviteTtlMinutes ?? 60);
  if (!ROOM_ID_RE.test(roomId) || !roomName) throw new Error('Configuração da sala inválida.');
  if (![2, 3, 4].includes(maxParticipants)) throw new Error('Limite de participantes inválido.');
  if (pin && !/^\d{4,12}$/.test(pin)) throw new Error('PIN inválido.');
  if (!ALLOWED_INVITE_TTL_MINUTES.has(inviteTtlMinutes)) throw new Error('Expiração do convite inválida.');
  return { roomId, roomName, maxParticipants, pin: pin || undefined, approvalRequired: Boolean(options.approvalRequired), inviteTtlMinutes };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) hideMainWindow();
  else showMainWindow();
}

function deliverDeepLink(url) {
  const safeUrl = normalizeDeepLink(url);
  if (!safeUrl) return;
  pendingDeepLink = safeUrl;
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    if (!mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('app:deep-link', safeUrl);
      pendingDeepLink = null;
    }
  }
}

function loadDesktopPreferences() {
  preferencesPath = join(app.getPath('userData'), 'desktop-preferences.json');
  try {
    if (!existsSync(preferencesPath)) return;
    const parsed = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    for (const key of Object.keys(DEFAULT_DESKTOP_PREFERENCES)) {
      if (typeof parsed?.[key] === 'boolean') desktopPreferences[key] = parsed[key];
    }
  } catch (cause) {
    console.warn('[desktop] não foi possível ler preferências:', cause instanceof Error ? cause.message : String(cause));
  }
}

function persistDesktopPreferences() {
  if (!preferencesPath) return;
  try {
    writeFileSync(preferencesPath, `${JSON.stringify(desktopPreferences, null, 2)}\n`, 'utf8');
  } catch (cause) {
    console.warn('[desktop] não foi possível salvar preferências:', cause instanceof Error ? cause.message : String(cause));
  }
}

function getLaunchAtStartupState() {
  if (!app.isPackaged) return { supported: false, openAtLogin: false };
  try {
    const settings = app.getLoginItemSettings({ path: getDesktopExecutablePath(), args: ['--hidden'] });
    return {
      supported: true,
      openAtLogin: Boolean(settings.executableWillLaunchAtLogin ?? settings.openAtLogin),
    };
  } catch {
    return { supported: true, openAtLogin: false };
  }
}

function applyLaunchAtStartup(enabled) {
  desktopPreferences.launchAtStartup = Boolean(enabled);
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: desktopPreferences.launchAtStartup,
      path: getDesktopExecutablePath(),
      args: ['--hidden'],
      enabled: desktopPreferences.launchAtStartup,
      name: 'Discordy',
    });
  }
  persistDesktopPreferences();
  return getLaunchAtStartupState();
}

function showNativeNotification(payload = {}) {
  if (!desktopPreferences.notifications || !Notification.isSupported()) return false;
  const title = String(payload.title || 'Discordy').slice(0, 120);
  const body = String(payload.body || '').slice(0, 500);
  if (!body) return false;
  const notification = new Notification({
    title,
    body,
    silent: Boolean(payload.silent),
    timeoutType: 'default',
  });
  notification.on('click', () => showMainWindow());
  notification.show();
  return true;
}

function sendDesktopCommand(type, source = 'global') {
  if (type === 'toggle-window') {
    toggleMainWindow();
    return;
  }
  sendToRenderer('desktop:command', { type, source, at: Date.now() });
}

function safeRegisterShortcut(accelerator, callback) {
  try {
    return globalShortcut.register(accelerator, callback);
  } catch {
    return false;
  }
}

function stopGlobalKeyMonitor() {
  if (!globalKeyMonitor) return;
  try { globalKeyMonitor.kill(); } catch { /* noop */ }
  globalKeyMonitor = null;
  globalKeyMonitorBuffer = '';
  shortcutStatus.holdKeys = false;
}

function handleGlobalKeyMonitorLine(line) {
  const command = line.trim();
  if (!command) return;
  if (command === 'PTT_DOWN') sendDesktopCommand('ptt-down', 'global-hold');
  if (command === 'PTT_UP') sendDesktopCommand('ptt-up', 'global-hold');
  if (command === 'PTM_DOWN') sendDesktopCommand('ptm-down', 'global-hold');
  if (command === 'PTM_UP') sendDesktopCommand('ptm-up', 'global-hold');
}

function startGlobalKeyMonitor() {
  stopGlobalKeyMonitor();
  if (!desktopPreferences.globalShortcuts || process.platform !== 'win32') return false;
  const scriptPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'global-key-monitor.ps1')
    : join(__dirname, 'global-key-monitor.ps1');
  if (!existsSync(scriptPath)) return false;

  try {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    globalKeyMonitor = child;
    shortcutStatus.holdKeys = true;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      globalKeyMonitorBuffer += chunk;
      const lines = globalKeyMonitorBuffer.split(/\r?\n/);
      globalKeyMonitorBuffer = lines.pop() || '';
      for (const line of lines) handleGlobalKeyMonitorLine(line);
    });
    child.on('exit', () => {
      if (globalKeyMonitor === child) globalKeyMonitor = null;
      shortcutStatus.holdKeys = false;
    });
    child.on('error', () => {
      if (globalKeyMonitor === child) globalKeyMonitor = null;
      shortcutStatus.holdKeys = false;
    });
    return true;
  } catch {
    shortcutStatus.holdKeys = false;
    return false;
  }
}

function configureGlobalShortcuts() {
  globalShortcut.unregisterAll();
  stopGlobalKeyMonitor();
  shortcutStatus = { mute: false, deafen: false, toggleWindow: false, holdKeys: false };
  if (!desktopPreferences.globalShortcuts) {
    rebuildTrayMenu();
    return;
  }

  shortcutStatus.mute = safeRegisterShortcut('CommandOrControl+Shift+M', () => sendDesktopCommand('toggle-mute'));
  shortcutStatus.deafen = safeRegisterShortcut('CommandOrControl+Shift+D', () => sendDesktopCommand('toggle-deafen'));
  shortcutStatus.toggleWindow = safeRegisterShortcut('CommandOrControl+Shift+Space', () => sendDesktopCommand('toggle-window'));
  shortcutStatus.holdKeys = startGlobalKeyMonitor();
  rebuildTrayMenu();
}

function getDesktopRuntimeState() {
  const startup = getLaunchAtStartupState();
  return {
    preferences: { ...desktopPreferences, launchAtStartup: startup.supported ? startup.openAtLogin : desktopPreferences.launchAtStartup },
    launchAtStartupSupported: startup.supported,
    notificationSupported: Notification.isSupported(),
    globalHoldSupported: process.platform === 'win32',
    shortcuts: { ...shortcutStatus },
    windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
  };
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const shortcutsEnabled = desktopPreferences.globalShortcuts;
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Discordy', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: trayMediaState.micEnabled ? 'Silenciar microfone' : 'Ativar microfone',
      enabled: shortcutsEnabled,
      accelerator: 'CommandOrControl+Shift+M',
      click: () => sendDesktopCommand('toggle-mute', 'tray'),
    },
    {
      label: trayMediaState.deafened ? 'Ativar áudio' : 'Silenciar áudio (Deafen)',
      enabled: shortcutsEnabled,
      accelerator: 'CommandOrControl+Shift+D',
      click: () => sendDesktopCommand('toggle-deafen', 'tray'),
    },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: Boolean(desktopPreferences.launchAtStartup),
      enabled: app.isPackaged,
      click: (item) => {
        applyLaunchAtStartup(Boolean(item.checked));
        sendToRenderer('desktop:preferences-changed', getDesktopRuntimeState());
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Encerrar Discordy',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(trayMediaState.deafened ? 'Discordy — áudio silenciado' : trayMediaState.micEnabled ? 'Discordy — microfone ativo' : 'Discordy — microfone silenciado');
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'tray.png')
    : join(__dirname, '..', 'assets', 'tray.png');
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  rebuildTrayMenu();
}

registerProtocol();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', (_event, commandLine) => {
  const deepLink = extractDeepLink(commandLine);
  if (deepLink) deliverDeepLink(deepLink);
  else showMainWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});


function publishUpdateState(patch = {}) {
  updateState = {
    ...updateState,
    ...patch,
    currentVersion: app.getVersion(),
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  };
  sendToRenderer('updates:state', updateState);
  return { ...updateState };
}

function updaterErrorMessage(cause) {
  const raw = cause instanceof Error ? cause.message : String(cause || 'Erro desconhecido.');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function checkForApplicationUpdates() {
  if (!updateState.supported || !updaterInstance) return { ...updateState };
  if (updateState.status === 'checking' || updateState.status === 'downloading') return { ...updateState };
  publishUpdateState({ status: 'checking', progress: null, message: 'Verificando atualizações...', error: null });
  try {
    await updaterInstance.checkForUpdates();
  } catch (cause) {
    publishUpdateState({ status: 'error', message: 'Não foi possível verificar atualizações.', error: updaterErrorMessage(cause) });
  }
  return { ...updateState };
}

async function downloadApplicationUpdate() {
  if (!updateState.supported || !updaterInstance) return { ...updateState };
  if (updateState.status === 'downloading' || updateState.status === 'downloaded') return { ...updateState };
  if (updateState.status !== 'available') {
    await checkForApplicationUpdates();
    if (updateState.status !== 'available') return { ...updateState };
  }
  publishUpdateState({ status: 'downloading', progress: 0, message: 'Baixando atualização...', error: null });
  try {
    await updaterInstance.downloadUpdate();
  } catch (cause) {
    publishUpdateState({ status: 'error', message: 'Falha ao baixar a atualização.', error: updaterErrorMessage(cause) });
  }
  return { ...updateState };
}

async function installDownloadedApplicationUpdate() {
  if (!updateState.supported || !updaterInstance || updateState.status !== 'downloaded') return false;
  isQuitting = true;
  try { await hostService.stop(); } catch { /* noop */ }
  setTimeout(() => {
    try {
      // electron-updater 6.x uses positional arguments: isSilent, isForceRunAfter.
      updaterInstance.quitAndInstall(false, true);
    } catch (cause) {
      isQuitting = false;
      publishUpdateState({ status: 'error', message: 'Falha ao iniciar o instalador da atualização.', error: updaterErrorMessage(cause) });
    }
  }, 150);
  return true;
}

async function initializeAutoUpdater() {
  if (process.platform !== 'win32') {
    publishUpdateState({ supported: false, status: 'unsupported', message: 'Auto-update está habilitado somente no Windows nesta versão.', error: null });
    return;
  }
  if (!app.isPackaged) {
    publishUpdateState({ supported: false, status: 'unsupported', message: 'Auto-update é desativado durante o desenvolvimento.', error: null });
    return;
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    publishUpdateState({ supported: false, status: 'unsupported', message: 'A edição Portable não instala updates automaticamente. Use o Discordy Setup.', error: null });
    return;
  }
  const updateConfigPath = join(process.resourcesPath, 'app-update.yml');
  if (!existsSync(updateConfigPath)) {
    publishUpdateState({ supported: false, status: 'unsupported', message: 'Este build não possui configuração de release. Publique pelo workflow do GitHub.', error: null });
    return;
  }

  try {
    const updaterModule = await import('electron-updater');
    updaterInstance = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater ?? null;
    if (!updaterInstance) throw new Error('electron-updater não disponibilizou autoUpdater.');

    updaterInstance.autoDownload = false;
    updaterInstance.autoInstallOnAppQuit = false;
    updaterInstance.allowPrerelease = false;
    updaterInstance.logger = console;

    updaterInstance.on('checking-for-update', () => {
      publishUpdateState({ status: 'checking', progress: null, message: 'Verificando atualizações...', error: null });
    });
    updaterInstance.on('update-available', (info) => {
      publishUpdateState({ status: 'available', availableVersion: String(info?.version || ''), progress: 0, message: `Discordy ${info?.version || ''} disponível.`, error: null });
      showNativeNotification({ title: 'Atualização do Discordy', body: `A versão ${info?.version || 'mais recente'} está disponível.`, silent: true });
    });
    updaterInstance.on('update-not-available', () => {
      publishUpdateState({ status: 'idle', availableVersion: null, progress: null, message: 'Discordy está atualizado.', error: null });
    });
    updaterInstance.on('download-progress', (progress) => {
      const percent = Number(progress?.percent);
      publishUpdateState({
        status: 'downloading',
        progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
        message: 'Baixando atualização...',
        error: null,
      });
    });
    updaterInstance.on('update-downloaded', (info) => {
      publishUpdateState({ status: 'downloaded', availableVersion: String(info?.version || updateState.availableVersion || ''), progress: 100, message: 'Atualização pronta para instalar.', error: null });
      showNativeNotification({ title: 'Discordy atualizado', body: 'A nova versão foi baixada. Reinicie para instalar.', silent: true });
    });
    updaterInstance.on('error', (cause) => {
      publishUpdateState({ status: 'error', message: 'Erro no sistema de atualização.', error: updaterErrorMessage(cause) });
    });

    publishUpdateState({ supported: true, status: 'idle', message: 'Atualizações via GitHub Releases ativas.', error: null });
    setTimeout(() => void checkForApplicationUpdates(), 4500);
  } catch (cause) {
    updaterInstance = null;
    publishUpdateState({ supported: false, status: 'error', message: 'O módulo de atualização não pôde ser inicializado.', error: updaterErrorMessage(cause) });
  }
}

function configureMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((webContents, permission) => {
    if (!mainWindow || webContents?.id !== mainWindow.webContents.id || !isTrustedRendererUrl(webContents.getURL())) return false;
    return permission === 'media' || permission === 'speaker-selection';
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const trusted = Boolean(mainWindow && webContents.id === mainWindow.webContents.id && isTrustedRendererUrl(webContents.getURL()));
    callback(Boolean(trusted && (permission === 'media' || permission === 'speaker-selection')));
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const selection = pendingDisplaySelection;
      pendingDisplaySelection = null;
      if (!selection?.sourceId) return callback({});

      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const source = sources.find((candidate) => candidate.id === selection.sourceId);
      if (!source) return callback({});

      const streams = { video: source };
      if (selection.includeAudio && request.audioRequested && process.platform === 'win32') {
        streams.audio = 'loopback';
      }
      callback(streams);
    } catch {
      callback({});
    }
  });
}

function createWindow(forceShow = false) {
  const startedHidden = !forceShow && process.argv.includes('--hidden') && !extractDeepLink(process.argv);
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 920,
    minHeight: 650,
    backgroundColor: '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!startedHidden) mainWindow?.show();
  });

  mainWindow.on('minimize', (event) => {
    if (!desktopPreferences.minimizeToTray || isQuitting) return;
    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on('close', (event) => {
    if (!desktopPreferences.closeToTray || isQuitting) return;
    event.preventDefault();
    hideMainWindow();
    if (!trayHintShown) {
      trayHintShown = true;
      showNativeNotification({ title: 'Discordy continua aberto', body: 'O aplicativo foi minimizado para a bandeja do sistema.', silent: true });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    void openExternalSafe(url);
  });

  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('desktop:preferences-changed', getDesktopRuntimeState());
    mainWindow?.webContents.send('updates:state', updateState);
    if (pendingDeepLink) {
      mainWindow?.webContents.send('app:deep-link', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('screen:list-sources', async (event) => {
  assertTrustedIpc(event);
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 360, height: 210 },
    fetchWindowIcons: false,
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.id.startsWith('screen:') ? 'monitor' : 'window',
    thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    displayId: source.display_id || null,
  }));
});

ipcMain.on('screen:select-source', (event, payload) => {
  try { assertTrustedIpc(event); } catch { event.returnValue = false; return; }
  pendingDisplaySelection = {
    sourceId: String(payload?.sourceId || ''),
    includeAudio: Boolean(payload?.includeAudio),
  };
  event.returnValue = Boolean(pendingDisplaySelection.sourceId);
});

ipcMain.handle('cloudflared:check', async (event) => { assertTrustedIpc(event); return await hostService.checkCloudflared(); });
ipcMain.handle('cloudflared:open-download', async (event) => {
  assertTrustedIpc(event);
  return await openExternalSafe(CLOUDFLARED_DOWNLOAD_URL);
});
ipcMain.handle('host:start', async (event, options) => {
  assertTrustedIpc(event);
  return await hostService.start(sanitizeHostStartOptions(options));
});
ipcMain.handle('host:stop', async (event) => {
  assertTrustedIpc(event);
  await hostService.stop();
  return true;
});
ipcMain.handle('clipboard:write-text', (event, text) => {
  assertTrustedIpc(event);
  const normalized = String(text || '').slice(0, MAX_CLIPBOARD_TEXT_LENGTH);
  clipboard.writeText(normalized);
  return true;
});

ipcMain.handle('desktop:get-state', (event) => { assertTrustedIpc(event); return getDesktopRuntimeState(); });
ipcMain.handle('desktop:update-preferences', (event, changes = {}) => {
  assertTrustedIpc(event);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Preferências inválidas.');
  const previousGlobal = desktopPreferences.globalShortcuts;
  for (const key of Object.keys(DEFAULT_DESKTOP_PREFERENCES)) {
    if (key === 'launchAtStartup') continue;
    if (typeof changes?.[key] === 'boolean') desktopPreferences[key] = changes[key];
  }
  if (typeof changes?.launchAtStartup === 'boolean') applyLaunchAtStartup(changes.launchAtStartup);
  else persistDesktopPreferences();

  if (desktopPreferences.globalShortcuts !== previousGlobal) configureGlobalShortcuts();
  rebuildTrayMenu();
  const state = getDesktopRuntimeState();
  sendToRenderer('desktop:preferences-changed', state);
  return state;
});
ipcMain.handle('desktop:notify', (event, payload) => { assertTrustedIpc(event); return showNativeNotification(payload); });
ipcMain.handle('desktop:show-window', (event) => {
  assertTrustedIpc(event);
  showMainWindow();
  return true;
});
ipcMain.handle('desktop:hide-window', (event) => {
  assertTrustedIpc(event);
  hideMainWindow();
  return true;
});
ipcMain.on('desktop:update-media-state', (event, state = {}) => {
  try { assertTrustedIpc(event); } catch { return; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return;
  trayMediaState = {
    micEnabled: typeof state.micEnabled === 'boolean' ? state.micEnabled : trayMediaState.micEnabled,
    deafened: typeof state.deafened === 'boolean' ? state.deafened : trayMediaState.deafened,
  };
  rebuildTrayMenu();
});


ipcMain.handle('updates:get-state', (event) => {
  assertTrustedIpc(event);
  return { ...updateState };
});
ipcMain.handle('updates:check', async (event) => {
  assertTrustedIpc(event);
  return await checkForApplicationUpdates();
});
ipcMain.handle('updates:download', async (event) => {
  assertTrustedIpc(event);
  return await downloadApplicationUpdate();
});
ipcMain.handle('updates:install', async (event) => {
  assertTrustedIpc(event);
  return await installDownloadedApplicationUpdate();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (mainWindow && contents.id === mainWindow.webContents.id) void openExternalSafe(url);
    return { action: 'deny' };
  });
});

if (gotLock) {
  app.whenReady().then(() => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    loadDesktopPreferences();
    if (app.isPackaged) {
      desktopPreferences.launchAtStartup = getLaunchAtStartupState().openAtLogin;
      persistDesktopPreferences();
    }
    configureMediaPermissions();
    createTray();
    createWindow();
    configureGlobalShortcuts();
    void initializeAutoUpdater();
    deliverDeepLink(extractDeepLink(process.argv));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  stopGlobalKeyMonitor();
  globalShortcut.unregisterAll();
  void hostService.stop();
});

app.on('will-quit', () => {
  stopGlobalKeyMonitor();
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) tray.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (isQuitting || !desktopPreferences.closeToTray) app.quit();
});
