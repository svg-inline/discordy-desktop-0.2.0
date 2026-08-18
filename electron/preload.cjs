const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('discordy', {
  platform: process.platform,
  cloudflared: {
    check: () => ipcRenderer.invoke('cloudflared:check'),
    openDownload: () => ipcRenderer.invoke('cloudflared:open-download'),
  },
  host: {
    start: () => ipcRenderer.invoke('host:start'),
    stop: () => ipcRenderer.invoke('host:stop'),
    onStatus: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('host:status', handler);
      return () => ipcRenderer.removeListener('host:status', handler);
    },
    onLog: (callback) => {
      const handler = (_event, line) => callback(line);
      ipcRenderer.on('host:log', handler);
      return () => ipcRenderer.removeListener('host:log', handler);
    },
  },
  screen: {
    listSources: () => ipcRenderer.invoke('screen:list-sources'),
    selectSource: (sourceId, includeAudio) => ipcRenderer.sendSync('screen:select-source', { sourceId, includeAudio }),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },
  onDeepLink: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('app:deep-link', handler);
    return () => ipcRenderer.removeListener('app:deep-link', handler);
  },
});
