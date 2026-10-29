import type { ProbeResult, SavedServer } from '@anchi/daemon/client';
import type { SkillAddResult } from '@anchi/protocol';

/** What the window knows about its daemon connection. */
export interface ServerState {
  /** `local`, `instabox:<machine>` or `ssh:<host>`. */
  name: string;
  label: string;
  status: 'connecting' | 'connected' | 'error' | 'disconnected' | 'needs-setup' | 'installing';
  error?: string;
}

export interface ReleaseUpdate {
  currentVersion: string;
  version: string;
  url: string;
}

/** The narrow API the preload script gives the page (`window.anchi`). */
export interface AnchiApi {
  call(server: string, method: string, params?: object): Promise<unknown>;
  /** Daemon notifications; returns a function that stops listening. */
  onNotify(listener: (server: string, name: string, params: unknown) => void): () => void;
  server(): Promise<ServerState>;
  connections(): Promise<ServerState[]>;
  onConnections(listener: (states: ServerState[]) => void): () => void;
  connectServer(target: string, connected: boolean): Promise<void>;
  /** Selects a machine without closing the other connections. */
  setServer(target: string): Promise<ServerState>;
  /** `local` first, then the saved remote servers. */
  servers(): Promise<SavedServer[]>;
  addServer(name: string, target: string): Promise<{ saved: SavedServer; probe: ProbeResult }>;
  initializeServer(target: string): Promise<boolean>;
  removeServer(name: string): Promise<SavedServer[]>;
  openExternal(url: string): Promise<void>;
  update(): Promise<ReleaseUpdate | null>;
  onUpdate(listener: (update: ReleaseUpdate | null) => void): () => void;
  /** Copies the fixed local upgrade command, never arbitrary renderer-provided text. */
  copyUpdateCommand(): Promise<void>;
  /** Picks a folder on this computer and adds the skills in it; null when cancelled. */
  addSkillFolder(server: string): Promise<SkillAddResult | null>;
  /** Picks a Google OAuth client JSON on this computer and imports it; false when cancelled. */
  importGoogleClient(server: string): Promise<boolean>;
}
