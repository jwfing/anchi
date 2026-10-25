import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AnchiApi, ServerState } from '../shared.ts';

const api: AnchiApi = {
  call: (method, params) => ipcRenderer.invoke('anchi:call', method, params ?? {}),
  onNotify(listener) {
    const handler = (_e: IpcRendererEvent, name: string, params: unknown) => listener(name, params);
    ipcRenderer.on('anchi:notify', handler);
    return () => ipcRenderer.off('anchi:notify', handler);
  },
  server: () => ipcRenderer.invoke('anchi:server'),
  onServer(listener) {
    const handler = (_e: IpcRendererEvent, state: ServerState) => listener(state);
    ipcRenderer.on('anchi:server', handler);
    return () => ipcRenderer.off('anchi:server', handler);
  },
  setServer: (target) => ipcRenderer.invoke('anchi:setServer', target),
  servers: () => ipcRenderer.invoke('anchi:servers'),
  addServer: (name, target) => ipcRenderer.invoke('anchi:addServer', name, target),
  removeServer: (name) => ipcRenderer.invoke('anchi:removeServer', name),
  openExternal: (url) => ipcRenderer.invoke('anchi:openExternal', url),
  addSkillFolder: () => ipcRenderer.invoke('anchi:addSkillFolder'),
};

contextBridge.exposeInMainWorld('anchi', api);
