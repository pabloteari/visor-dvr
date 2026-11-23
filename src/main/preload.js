'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dvr', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  testConfig: (c) => ipcRenderer.invoke('config:test', c),
  setConfig: (c) => ipcRenderer.invoke('config:set', c),
  info: () => ipcRenderer.invoke('dvr:info'),
  now: () => ipcRenderer.invoke('dvr:now'),
  recordings: (q) => ipcRenderer.invoke('dvr:recordings', q),
  storage: (q) => ipcRenderer.invoke('dvr:storage', q),
  thumb: (q) => ipcRenderer.invoke('media:thumb', q),
  snapshot: (q) => ipcRenderer.invoke('media:snapshot', q),
  openStream: (o) => ipcRenderer.invoke('stream:open', o),
  chooseDir: () => ipcRenderer.invoke('export:chooseDir'),
  exportClip: (o) => ipcRenderer.invoke('export:run', o),
  showFile: (f) => ipcRenderer.invoke('shell:show', f),
  onExportProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('export:progress', h);
    return () => ipcRenderer.removeListener('export:progress', h);
  },
});
