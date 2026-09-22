const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  invoke: (op, args) => ipcRenderer.invoke('desktop:command', op, args),
  submitToken: (value) => ipcRenderer.invoke('desktop:token', value),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  },
});
