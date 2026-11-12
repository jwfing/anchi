import { sanitizeLine } from '@anchi/core/sanitize';
import type { SetupStatus } from '@anchi/protocol';
import type { ServerState } from '../api.ts';
import { useApp } from '../App.tsx';
import { count } from '../format.ts';
import { Icon } from '../ui.tsx';

export type CheckState = 'done' | 'now' | 'wait' | 'fail';
export interface Check {
  id: 'service' | 'room' | 'vault' | 'agents';
  title: string;
  detail: string;
  state: CheckState;
  status: string;
}

/**
 * What has to be up before agents can work, in the order it comes up: the daemon, the VM, the
 * vault, then the agents. Nothing below a part that is not up yet can be known, so it waits.
 */
export function startChecklist(
  server: Pick<ServerState, 'status'>,
  setup: SetupStatus | undefined,
  agents: number,
): Check[] {
  const service: CheckState =
    server.status === 'connected'
      ? 'done'
      : server.status === 'connecting' || server.status === 'installing'
        ? 'now'
        : 'fail';
  const up = service === 'done';
  const room: CheckState = !up
    ? 'wait'
    : !setup
      ? 'now'
      : setup.vm === 'running' && setup.installed
        ? 'done'
        : 'fail';
  const vault: CheckState = room !== 'done' ? 'wait' : setup?.vaultUnlocked ? 'done' : 'fail';
  return [
    {
      id: 'service',
      title: 'Background service',
      detail: 'Keeps agents working when this window is closed',
      state: service,
      status:
        service === 'done'
          ? 'Running'
          : service === 'now'
            ? 'Starting…'
            : server.status === 'disconnected'
              ? 'Disconnected'
              : server.status === 'needs-setup'
                ? 'Not installed'
                : 'Did not start',
    },
    {
      id: 'room',
      title: 'Secure room',
      detail: 'The sealed space your agents run in',
      state: room,
      status:
        room === 'done'
          ? 'Running'
          : room === 'now'
            ? 'Checking…'
            : room === 'wait'
              ? 'Waiting'
              : setup?.installed
                ? 'Stopped'
                : 'Not set up',
    },
    {
      id: 'vault',
      title: 'Vault',
      detail: 'Holds the accounts you connected, encrypted',
      state: vault,
      status: vault === 'done' ? 'Unlocked' : vault === 'wait' ? 'Waiting' : 'Locked',
    },
    {
      id: 'agents',
      title: 'Your agents',
      detail: up ? count(agents, 'agent') : 'Listed once the service runs',
      state: up ? 'done' : 'wait',
      status: up ? 'Ready' : 'Waiting',
    },
  ];
}

/** In place of a view while its machine is not up: what is starting, and the one thing to do. */
export function StartingView() {
  const { server, model, act, setView } = useApp();
  const checks = startChecklist(
    server,
    model.setup,
    model.agents.filter((a) => a.id !== 'builder' && !a.peer).length,
  );
  const where = server.name === 'local' ? 'this computer' : sanitizeLine(server.label);
  const starting = server.status === 'connecting' || server.status === 'installing';
  const title = starting
    ? server.status === 'installing'
      ? `Installing Anchi on ${where}`
      : 'Starting Anchi'
    : server.status === 'needs-setup'
      ? `Anchi is not installed on ${where} yet`
      : server.status === 'disconnected'
        ? `${where[0]!.toUpperCase()}${where.slice(1)} is disconnected`
        : server.name === 'local'
          ? 'The background service did not start'
          : `Anchi cannot reach ${where}`;
  return (
    <main className="main starting">
      <div className="starting-col">
        <div className="col gap-s center">
          <h1>{title}</h1>
          <span className="muted">
            {starting
              ? 'Usually ready in about ten seconds.'
              : server.status === 'needs-setup'
                ? 'Install it from Machines to run agents there.'
                : server.status === 'disconnected'
                  ? 'Its agents and tasks keep running; this window stopped listening.'
                  : sanitizeLine(server.error ?? 'Nothing was changed.')}
          </span>
        </div>
        <div className="checklist">
          {checks.map((c) => (
            <div key={c.id} className={`check check-${c.state}`}>
              <span className="check-mark" aria-hidden="true">
                {c.state === 'done' ? (
                  <Icon name="check" size={13} />
                ) : c.state === 'fail' ? (
                  <Icon name="x" size={13} />
                ) : c.state === 'now' ? (
                  <span className="spinner" />
                ) : null}
              </span>
              <span className="col grow gap-xs min0">
                <span className="strong">{c.title}</span>
                <span className="small muted">{c.detail}</span>
              </span>
              <span className="small check-status">{c.status}</span>
            </div>
          ))}
        </div>
        {!starting && (
          <div className="row gap">
            {server.status !== 'needs-setup' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void act(() => window.anchi.connectServer(server.name, true))}
              >
                {server.status === 'disconnected' ? 'Connect' : 'Try again'}
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => setView({ kind: 'settings', section: 'machines' })}
            >
              Open Machines
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
