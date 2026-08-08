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
      'speak', 'speak-followup', 'state', 'screen', 'hotkey',
      'permissions', 'observer-error', 'deadman-abort', 'notice', 'artifact',
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
  downloadArtifacts: () => ipcRenderer.invoke('download-artifacts'),
  learnerInput: () => ipcRenderer.send('learner-input'),
  heard: (text) => ipcRenderer.send('heard', text),
  // Anam lifecycle breadcrumbs for the session transcript. Event names only —
  // main whitelists them; no payload crosses the bridge.
  note: (event) => ipcRenderer.send('transcript-note', String(event)),
  openAccessibilitySettings: () => ipcRenderer.send('open-accessibility-settings'),
});
