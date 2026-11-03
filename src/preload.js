const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: data => ipcRenderer.invoke('data:save', data),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  saveBackup: opts => ipcRenderer.invoke('backup:save', opts),
  openBackup: () => ipcRenderer.invoke('backup:open'),
  unlockBackupKey: password => ipcRenderer.invoke('backup:unlockKey', password),
  applyBackup: opts => ipcRenderer.invoke('backup:apply', opts),
  openImportFile: () => ipcRenderer.invoke('import:open'),
  exportXlsx: payload => ipcRenderer.invoke('export:xlsx', payload),
  exportKmz: payload => ipcRenderer.invoke('export:kmz', payload),
  geocode: req => ipcRenderer.invoke('geo:geocode', req),
  townAt: req => ipcRenderer.invoke('geo:town', req),
  openExternal: url => ipcRenderer.invoke('app:openExternal', url),
  googleKeyStatus: () => ipcRenderer.invoke('google:keyStatus'),
  googleSetKey: key => ipcRenderer.invoke('google:setKey', key),
  googleSearch: req => ipcRenderer.invoke('google:search', req),
  googleDetails: placeId => ipcRenderer.invoke('google:details', placeId),
  googleResolveLink: url => ipcRenderer.invoke('google:resolveLink', url),
});
