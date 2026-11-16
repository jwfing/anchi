import { join } from 'node:path';

/**
 * Where the host services keep everything, under the daemon's `~/.anchi/host`: state/auth
 * (the vault), state/ca (the proxy's CA), state/run (control.sock, control.token),
 * state/egress/settings.json, audit.jsonl and ca-bundle.pem. The daemon and the process agree
 * through this one function.
 */
export interface HostServicesPaths {
  root: string;
  state: string;
  auth: string;
  ca: string;
  run: string;
  control: string;
  token: string;
  settings: string;
  audit: string;
  bundle: string;
  caCert: string;
}

export function hostServicesPaths(root: string): HostServicesPaths {
  const state = join(root, 'state');
  return {
    root,
    state,
    auth: join(state, 'auth'),
    ca: join(state, 'ca'),
    run: join(state, 'run'),
    control: join(state, 'run/control.sock'),
    token: join(state, 'run/control.token'),
    settings: join(state, 'egress/settings.json'),
    audit: join(root, 'audit.jsonl'),
    bundle: join(root, 'ca-bundle.pem'),
    caCert: join(state, 'ca/ca.pem'),
  };
}
