'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tonySetup', {
  submit: (code) => ipcRenderer.invoke('setup-submit', code),
});
