import { sanitizeLine } from '@anchi/core/sanitize';
import type { PeerDirectory, PeerRecord } from '@anchi/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../App.tsx';
import { machineCall, message } from '../api.ts';

/** Enrollment exchanges public certificates through existing owner-authenticated connections. */
export function PeerSettings() {
  const { call, act, server, connections } = useApp();
  const [directory, setDirectory] = useState<PeerDirectory>();
  const [identity, setIdentity] = useState<PeerRecord>();
  const [error, setError] = useState('');
  const [label, setLabel] = useState(server.label);
  const [address, setAddress] = useState('');
  const [listen, setListen] = useState('0.0.0.0');
  const [port, setPort] = useState('9847');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const d = await call('peers.directory');
      setDirectory(d);
      if (!initialized.current && d.config) {
        setLabel(d.config.label);
        setAddress(d.config.address);
        setListen(d.config.listen);
        setPort(String(d.config.port));
        initialized.current = true;
      }
      if (d.configured) setIdentity(await call('peers.identity'));
      setError('');
    } catch (e) {
      const text = message(e);
      setError(
        text.includes('unknown method')
          ? 'Update this machine’s daemon to enable peer teams.'
          : text,
      );
    }
  }, [call]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act(work);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Peer team</h2>
      <p className="small muted">
        Every member keeps the same team directory and delegates directly. Each machine needs an
        address the others can reach, such as a VPN address. A saved SSH connection alone does not
        provide this network.
      </p>
      {error && <p className="tone-warn">{sanitizeLine(error)}</p>}
      {directory && (
        <>
          <details open={!directory.configured}>
            <summary>
              {identity ? `Network: ${identity.address}` : 'Configure this machine'}
            </summary>
            <form
              className="drawer"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  call('peers.configure', { label, address, listen, port: Number(port) }),
                );
              }}
            >
              <label className="field">
                Machine label
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              <label className="field">
                Reachable address
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="tls://100.64.0.2:9847"
                  required
                />
              </label>
              <div className="row gap">
                <label className="field">
                  Listen address
                  <input value={listen} onChange={(e) => setListen(e.target.value)} required />
                </label>
                <label className="field">
                  Listen port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    required
                  />
                </label>
              </div>
              <button className="btn btn-primary" disabled={busy}>
                Configure network…
              </button>
            </form>
          </details>
          {directory.configured && (
            <>
              <form
                className="peer-enroll"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const other = machineCall(target);
                    const own = await call('peers.identity');
                    const remote = await other('peers.identity');
                    await call('peers.admit', { record: remote });
                    await other('peers.admit', { record: own });
                  });
                }}
              >
                <label className="field grow">
                  Join with a machine
                  <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                    <option value="">Choose a configured machine</option>
                    {connections
                      .filter((c) => c.name !== server.name && c.status === 'connected')
                      .map((c) => (
                        <option key={c.name} value={c.name}>
                          {sanitizeLine(c.label)}
                        </option>
                      ))}
                  </select>
                </label>
                <button className="btn" disabled={busy || !target}>
                  Join team…
                </button>
              </form>
              <p className="small muted">
                Configure networking on both machines first. Join one trusted member to discover the
                others. Then grant recipients in each agent’s Delegation settings.
              </p>
              {directory.nodes.map((n) => (
                <div className="row gap" key={n.node}>
                  <span className="grow">
                    {sanitizeLine(n.label)} · {n.online ? 'online' : 'offline'} · {n.agents.length}{' '}
                    agents
                  </span>
                  {n.node !== directory.self && (
                    <button
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => void run(() => call('peers.remove', { node: n.node }))}
                    >
                      Revoke…
                    </button>
                  )}
                </div>
              ))}
              {identity && (
                <details>
                  <summary>Public identity</summary>
                  <pre
                    className="small mono"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {JSON.stringify(identity, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
