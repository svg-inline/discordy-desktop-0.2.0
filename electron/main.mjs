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

function extractDeepLink(args) {
  return args.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith('discordy://')) || null;
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
  if (!url) return;
  pendingDeepLink = url;
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    if (!mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('app:deep-link', url);
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

function configureMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((webContents, permission) => {
    if (!mainWindow || webContents?.id !== mainWindow.webContents.id) return false;
    return permission === 'media' || permission === 'speaker-selection';
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(Boolean(mainWindow && webContents.id === mainWindow.webContents.id && (permission === 'media' || permission === 'speaker-selection')));
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
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('desktop:preferences-changed', getDesktopRuntimeState());
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
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Renderer não autorizado.');
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
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    event.returnValue = false;
    return;
  }
  pendingDisplaySelection = {
    sourceId: String(payload?.sourceId || ''),
    includeAudio: Boolean(payload?.includeAudio),
  };
  event.returnValue = Boolean(pendingDisplaySelection.sourceId);
});

ipcMain.handle('cloudflared:check', async () => await hostService.checkCloudflared());
ipcMain.handle('cloudflared:open-download', async () => {
  await shell.openExternal(CLOUDFLARED_DOWNLOAD_URL);
  return true;
});
ipcMain.handle('host:start', async (_event, options) => await hostService.start(options));
ipcMain.handle('host:stop', async () => {
  await hostService.stop();
  return true;
});
ipcMain.handle('clipboard:write-text', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('desktop:get-state', () => getDesktopRuntimeState());
ipcMain.handle('desktop:update-preferences', (_event, changes = {}) => {
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
ipcMain.handle('desktop:notify', (_event, payload) => showNativeNotification(payload));
ipcMain.handle('desktop:show-window', () => {
  showMainWindow();
  return true;
});
ipcMain.handle('desktop:hide-window', () => {
  hideMainWindow();
  return true;
});
ipcMain.on('desktop:update-media-state', (_event, state = {}) => {
  trayMediaState = {
    micEnabled: typeof state.micEnabled === 'boolean' ? state.micEnabled : trayMediaState.micEnabled,
    deafened: typeof state.deafened === 'boolean' ? state.deafened : trayMediaState.deafened,
  };
  rebuildTrayMenu();
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
