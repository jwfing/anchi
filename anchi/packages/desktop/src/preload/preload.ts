import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AnchiApi, ServerState } from '../shared.ts';

const api: AnchiApi = {
  call: (server, method, params) => ipcRenderer.invoke('anchi:call', server, method, params ?? {}),
  onNotify(listener) {
    const handler = (_e: IpcRendererEvent, server: string, name: string, params: unknown) =>
      listener(server, name, params);
    ipcRenderer.on('anchi:notify', handler);
    return () => ipcRenderer.off('anchi:notify', handler);
  },
  server: () => ipcRenderer.invoke('anchi:server'),
  connections: () => ipcRenderer.invoke('anchi:connections'),
  onConnections(listener) {
    const handler = (_e: IpcRendererEvent, states: ServerState[]) => listener(states);
    ipcRenderer.on('anchi:connections', handler);
    return () => ipcRenderer.off('anchi:connections', handler);
  },
  connectServer: (target, connected) =>
    ipcRenderer.invoke('anchi:connectServer', target, connected),
  setServer: (target) => ipcRenderer.invoke('anchi:setServer', target),
  servers: () => ipcRenderer.invoke('anchi:servers'),
  addServer: (name, target) => ipcRenderer.invoke('anchi:addServer', name, target),
  removeServer: (name) => ipcRenderer.invoke('anchi:removeServer', name),
  openExternal: (url) => ipcRenderer.invoke('anchi:openExternal', url),
  addSkillFolder: (server) => ipcRenderer.invoke('anchi:addSkillFolder', server),
  importGoogleClient: (server) => ipcRenderer.invoke('anchi:importGoogleClient', server),
};

contextBridge.exposeInMainWorld('anchi', api);
