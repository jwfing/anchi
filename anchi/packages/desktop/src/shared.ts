import type { ProbeResult, SavedServer } from '@anchi/daemon/client';
import type { SkillAddResult } from '@anchi/protocol';

/** What the window knows about its daemon connection. */
export interface ServerState {
  /** `local`, `instabox:<machine>` or `ssh:<host>`. */
  name: string;
  status: 'connecting' | 'connected' | 'error';
  error?: string;
}

/** The narrow API the preload script gives the page (`window.anchi`). */
export interface AnchiApi {
  call(method: string, params?: object): Promise<unknown>;
  /** Daemon notifications; returns a function that stops listening. */
  onNotify(listener: (name: string, params: unknown) => void): () => void;
  server(): Promise<ServerState>;
  onServer(listener: (state: ServerState) => void): () => void;
  /** Connects to a saved server's name or a target, and makes it the one in use. */
  setServer(target: string): Promise<ServerState>;
  /** `local` first, then the saved remote servers. */
  servers(): Promise<SavedServer[]>;
  addServer(name: string, target: string): Promise<{ saved: SavedServer; probe: ProbeResult }>;
  removeServer(name: string): Promise<SavedServer[]>;
  openExternal(url: string): Promise<void>;
  /** Picks a folder on this computer and adds the skills in it; null when cancelled. */
  addSkillFolder(): Promise<SkillAddResult | null>;
  /** Picks a Google OAuth client JSON on this computer and imports it; false when cancelled. */
  importGoogleClient(): Promise<boolean>;
}
