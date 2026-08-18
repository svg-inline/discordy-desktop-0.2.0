import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostService } from './host-service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUDFLARED_DOWNLOAD_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
let mainWindow = null;
let pendingDeepLink = null;

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

const hostService = new HostService({
  logger: (line) => sendToRenderer('host:log', line),
  onStatus: (status) => sendToRenderer('host:status', status),
});

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('discordy', process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient('discordy');
  }
}

function extractDeepLink(args) {
  return args.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith('discordy://')) || null;
}

function deliverDeepLink(url) {
  if (!url) return;
  pendingDeepLink = url;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (!mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('app:deep-link', url);
      pendingDeepLink = null;
    }
  }
}

registerProtocol();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', (_event, commandLine) => {
  deliverDeepLink(extractDeepLink(commandLine));
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

function configureMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((webContents, permission) => {
    if (!mainWindow || webContents?.id !== mainWindow.webContents.id) return false;
    return permission === 'media';
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(Boolean(mainWindow && webContents.id === mainWindow.webContents.id && permission === 'media'));
  });

  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const firstScreen = sources.find((source) => source.id.startsWith('screen:')) || sources[0];
      if (!firstScreen) return callback({});
      callback({ video: firstScreen, audio: 'loopback' });
    } catch {
      callback({});
    }
  }, { useSystemPicker: true });
}

function createWindow() {
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

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
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

ipcMain.handle('cloudflared:check', async () => await hostService.checkCloudflared());
ipcMain.handle('cloudflared:open-download', async () => {
  await shell.openExternal(CLOUDFLARED_DOWNLOAD_URL);
  return true;
});
ipcMain.handle('host:start', async () => await hostService.start());
ipcMain.handle('host:stop', async () => {
  await hostService.stop();
  return true;
});
ipcMain.handle('clipboard:write-text', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

if (gotLock) {
  app.whenReady().then(() => {
    configureMediaPermissions();
    createWindow();
    deliverDeepLink(extractDeepLink(process.argv));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  void hostService.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
