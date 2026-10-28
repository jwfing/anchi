import type { SetupStatus } from '@anchi/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from './App.tsx';

/** Says when the vault on a running, installed guest is locked (it is after a restart). */
export function vaultLocked(s: SetupStatus): boolean {
  return (
    s.vm === 'running' && s.installed && !s.vaultUnlocked && s.vaultKeyPresent !== false && !s.error
  );
}

/** Sent when the vault was unlocked here, so every view that showed it locked asks again. */
const UNLOCKED = 'anchi:vault-unlocked';

/**
 * Unlocks the vault through setup.prepare, which the main process confirms in a system dialog.
 * With the environment installed and a runtime prepared, unlocking is all it does.
 */
export function useUnlockVault(): (status: SetupStatus) => Promise<boolean> {
  const { act, call } = useApp();
  return useCallback(
    async (status) => {
      const runtime = status.preparedRuntimes?.[0] ?? 'codex';
      const done = await act(
        () => call('setup.prepare', { runtime, confirm: true }),
        'Vault unlocked',
      );
      if (done) window.dispatchEvent(new Event(UNLOCKED));
      return Boolean(done);
    },
    [act, call],
  );
}

/** Calls `listener` when the vault was unlocked in this window. */
export function onVaultUnlocked(listener: () => void): () => void {
  window.addEventListener(UNLOCKED, listener);
  return () => window.removeEventListener(UNLOCKED, listener);
}

const EXPLANATION =
  'Your runtimes, connectors and services keep their credentials, but nothing can use them until it is unlocked. A restart of the server or VM locks it.';

/** In place of the credential cards in Settings while the vault is locked. */
export function VaultLockedCard({
  status,
  onUnlocked,
}: {
  status: SetupStatus;
  onUnlocked: () => void;
}) {
  const unlock = useUnlockVault();
  return (
    <section className="card">
      <h2>The vault is locked</h2>
      <p className="small muted">{EXPLANATION}</p>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void unlock(status).then((ok) => ok && onUnlocked())}
        >
          Unlock the vault
        </button>
      </div>
    </section>
  );
}

/** Across the window, so a locked vault is not mistaken for credentials that are gone. */
export function VaultBanner() {
  const { server, call } = useApp();
  const unlock = useUnlockVault();
  const [status, setStatus] = useState<SetupStatus>();
  useEffect(() => {
    setStatus(undefined);
    if (server.status !== 'connected') return;
    const check = () =>
      void call('setup.status')
        .then(setStatus)
        .catch(() => undefined);
    check();
    return onVaultUnlocked(check);
  }, [server.status, server.name, call]);
  if (!status || !vaultLocked(status)) return null;
  return (
    <div className="conn-banner vault-banner" role="status">
      <span className="dot dot-error" />
      <span className="grow">
        The vault on {server.name} is locked: agents cannot use your credentials until it is
        unlocked. They are still stored.
      </span>
      <button type="button" className="btn btn-small" onClick={() => void unlock(status)}>
        Unlock
      </button>
    </div>
  );
}
