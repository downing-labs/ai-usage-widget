'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Narrow, explicit bridge: the widget UI can only call these.
contextBridge.exposeInMainWorld('aiwAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),

  refresh: () => ipcRenderer.invoke('refresh'),
  signIn: (id) => ipcRenderer.invoke('sign-in', id),
  cancelSignIn: (id) => ipcRenderer.invoke('cancel-sign-in', id),
  signOut: (id) => ipcRenderer.invoke('sign-out', id),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  copyGeminiToken: () => ipcRenderer.invoke('copy-gemini-token'),
  newGeminiToken: () => ipcRenderer.invoke('new-gemini-token'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openExternal: (key) => ipcRenderer.invoke('open-external', key),
  dismissUpdate: () => ipcRenderer.invoke('dismiss-update'),
  openUpdate: () => ipcRenderer.invoke('open-update'),

  minimize: () => ipcRenderer.send('win-minimize'),
  hide: () => ipcRenderer.send('win-hide'),
  resize: (height, compact) => ipcRenderer.send('win-resize', height, compact),
});
