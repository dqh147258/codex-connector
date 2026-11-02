'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, value) => ipcRenderer.invoke(channel, value);
contextBridge.exposeInMainWorld('connector', Object.freeze({
  snapshot: () => invoke('desktop:snapshot'),
  listSessions: value => invoke('desktop:listSessions', value),
  saveConfig: value => invoke('desktop:saveConfig', value),
  saveCredentials: value => invoke('desktop:saveCredentials', value),
  savePreferences: value => invoke('desktop:savePreferences', value),
  testSlack: () => invoke('desktop:testSlack'),
  lookupDot: value => invoke('desktop:lookupDot', value),
  listUsers: () => invoke('desktop:listUsers'),
  listChannels: () => invoke('desktop:listChannels'),
  choosePath: value => invoke('desktop:choosePath', value),
  probeCodex: value => invoke('desktop:probeCodex', value),
  start: () => invoke('desktop:start'),
  stop: () => invoke('desktop:stop'),
  inspectLock: () => invoke('desktop:inspectLock'),
  recoverLock: () => invoke('desktop:recoverLock'),
  setLoginStartup: value => invoke('desktop:setLoginStartup', value),
  openHelp: value => invoke('desktop:openHelp', value),
  quit: () => invoke('desktop:quit')
}));
