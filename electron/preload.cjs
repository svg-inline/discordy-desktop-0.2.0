const { contextBridge, ipcRenderer } = require('electron');

const MAX_TEXT = 64 * 1024;

function safeString(value, max = 4096) {
  return String(value ?? '').slice(0, max);
}

function safeBoolean(value) {
  return Boolean(value);
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => undefined;
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  platform: process.platform,
  cloudflared: Object.freeze({
    check: () => ipcRenderer.invoke('cloudflared:check'),
    openDownload: () => ipcRenderer.invoke('cloudflared:open-download'),
  }),
  host: Object.freeze({
    start: (options = {}) => ipcRenderer.invoke('host:start', {
      roomId: safeString(options.roomId, 20),
      roomName: safeString(options.roomName, 60),
      maxParticipants: Number(options.maxParticipants),
      pin: options.pin ? safeString(options.pin, 12) : undefined,
      approvalRequired: safeBoolean(options.approvalRequired),
      inviteTtlMinutes: Number(options.inviteTtlMinutes ?? 60),
    }),
    stop: () => ipcRenderer.invoke('host:stop'),
    onStatus: (callback) => subscribe('host:status', callback),
    onLog: (callback) => subscribe('host:log', callback),
  }),
  screen: Object.freeze({
    listSources: () => ipcRenderer.invoke('screen:list-sources'),
    // sendSync preserves Chromium's transient user activation before getDisplayMedia().
    selectSource: (sourceId, includeAudio) => ipcRenderer.sendSync('screen:select-source', {
      sourceId: safeString(sourceId, 240),
      includeAudio: safeBoolean(includeAudio),
    }),
  }),
  clipboard: Object.freeze({
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', safeString(text, MAX_TEXT)),
  }),
  desktop: Object.freeze({
    getState: () => ipcRenderer.invoke('desktop:get-state'),
    updatePreferences: (changes = {}) => ipcRenderer.invoke('desktop:update-preferences', {
      minimizeToTray: typeof changes.minimizeToTray === 'boolean' ? changes.minimizeToTray : undefined,
      closeToTray: typeof changes.closeToTray === 'boolean' ? changes.closeToTray : undefined,
      notifications: typeof changes.notifications === 'boolean' ? changes.notifications : undefined,
      launchAtStartup: typeof changes.launchAtStartup === 'boolean' ? changes.launchAtStartup : undefined,
      globalShortcuts: typeof changes.globalShortcuts === 'boolean' ? changes.globalShortcuts : undefined,
    }),
    notify: (payload = {}) => ipcRenderer.invoke('desktop:notify', {
      title: safeString(payload.title || 'Discordy', 120),
      body: safeString(payload.body, 500),
      silent: safeBoolean(payload.silent),
    }),
    showWindow: () => ipcRenderer.invoke('desktop:show-window'),
    hideWindow: () => ipcRenderer.invoke('desktop:hide-window'),
    updateMediaState: (state = {}) => ipcRenderer.send('desktop:update-media-state', {
      micEnabled: typeof state.micEnabled === 'boolean' ? state.micEnabled : undefined,
      deafened: typeof state.deafened === 'boolean' ? state.deafened : undefined,
    }),
    onCommand: (callback) => subscribe('desktop:command', callback),
    onPreferencesChanged: (callback) => subscribe('desktop:preferences-changed', callback),
  }),
  onDeepLink: (callback) => subscribe('app:deep-link', callback),
};

contextBridge.exposeInMainWorld('discordy', Object.freeze(api));
