'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Deliberately narrow. The renderer runs third-party SDK code over WebRTC;
 * it gets exactly the channels it needs and no filesystem, no node, no keys.
 */
contextBridge.exposeInMainWorld('tony', {
  // main -> renderer
  on: (channel, fn) => {
    const allowed = [
      'speak', 'speak-followup', 'state', 'screen',
      'permissions', 'observer-error', 'deadman-abort',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // renderer -> main
  sessionToken: () => ipcRenderer.invoke('session-token'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  setAccountKind: (kind) => ipcRenderer.invoke('set-account-kind', kind),
  cacheReport: () => ipcRenderer.invoke('cache-report'),
  learnerInput: () => ipcRenderer.send('learner-input'),
  openAccessibilitySettings: () => ipcRenderer.send('open-accessibility-settings'),
});
