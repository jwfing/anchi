// What a client (CLI, TUI, desktop app) needs to reach a daemon, without the daemon itself:
// bundlers that follow this entry leave the VM, the store and the cell code out.
export { DaemonClient, Peer } from './rpc.ts';
export {
  addServer,
  callbackPort,
  chosenServer,
  connectRemote,
  listServers,
  parseServer,
  probeServer,
  type ProbeResult,
  type RemoteTarget,
  removeServer,
  resolveServer,
  type SavedServer,
  savedServer,
  saveServer,
  serverName,
  type ServerTarget,
} from './remote.ts';
