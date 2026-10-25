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
  setServer(target: string): Promise<ServerState>;
  openExternal(url: string): Promise<void>;
}
