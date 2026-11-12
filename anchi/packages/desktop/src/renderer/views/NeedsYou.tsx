import { sanitizeLine } from '@anchi/core/sanitize';
import type { Approval } from '@anchi/protocol';
import { useMemo, useState } from 'react';
import type { ReleaseUpdate, ServerState } from '../../shared.ts';
import { useApp } from '../App.tsx';
import { machineCall, message } from '../api.ts';
import type { Fleet } from '../model.ts';
import { Icon, type IconName } from '../ui.tsx';
import { vaultLocked, vaultUnlocked } from '../vault.tsx';
import { ApprovalCard } from './Approvals.tsx';

/** Something other than a held write that waits for the user, on a machine or in the app. */
export type Notice =
  | { kind: 'vault'; server: ServerState }
  | { kind: 'connection'; server: ServerState }
  | { kind: 'upgrade'; server: ServerState; version: string }
  | { kind: 'update'; update: ReleaseUpdate };

export interface Attention {
  approvals: { server: ServerState; approval: Approval }[];
  notices: Notice[];
}

/**
 * Everything that waits for a decision, from every machine: held writes first, oldest first,
 * then what keeps agents from working. A machine the user disconnected is not a problem.
 */
export function attention(
  fleet: Fleet,
  connections: ServerState[],
  update: ReleaseUpdate | null,
): Attention {
  const approvals = connections
    .flatMap((server) =>
      (fleet[server.name]?.approvals ?? []).map((approval) => ({ server, approval })),
    )
    .sort((a, b) => a.approval.createdAt - b.approval.createdAt);
  const notices: Notice[] = [];
  for (const server of connections) {
    const setup = fleet[server.name]?.setup;
    if (server.status === 'error' || server.status === 'needs-setup') {
      notices.push({ kind: 'connection', server });
    } else if (server.status === 'connected' && setup && vaultLocked(setup)) {
      notices.push({ kind: 'vault', server });
    }
    if (server.newer && server.install === 'release' && !server.upgrading) {
      notices.push({ kind: 'upgrade', server, version: server.newer });
    }
  }
  if (update) notices.push({ kind: 'update', update });
  return { approvals, notices };
}

export function attentionCount(a: Attention): number {
  return a.approvals.length + a.notices.length;
}

const where = (server: ServerState) =>
  server.name === 'local' ? 'this computer' : sanitizeLine(server.label);

/** One inbox for held writes and for what else needs the user, across machines. */
export function NeedsYouView({
  fleet,
  connections,
  update,
  onPostpone,
}: {
  fleet: Fleet;
  connections: ServerState[];
  update: ReleaseUpdate | null;
  onPostpone: () => void;
}) {
  const { setView, selectServer } = useApp();
  const { approvals, notices } = useMemo(
    () => attention(fleet, connections, update),
    [fleet, connections, update],
  );
  const many = connections.length > 1;
  const open = (server: ServerState, agentId: string) => {
    selectServer(server.name);
    setView({ kind: 'agent', agentId });
  };
  return (
    <main className="main scroll inbox">
      <div className="inbox-col">
        <div className="col gap-s">
          <h1>Needs you</h1>
          <p className="muted">
            {many
              ? 'Everything waiting for a decision, from every machine, in one place.'
              : 'Everything waiting for a decision, in one place.'}
          </p>
        </div>
        {approvals.map(({ server, approval }) => (
          <div key={`${server.name}:${approval.id}`} className="inbox-item">
            <ApprovalCard
              approval={approval}
              full
              call={machineCall(server.name)}
              machine={many ? where(server) : undefined}
            />
            <button
              type="button"
              className="link small"
              onClick={() => open(server, approval.agent)}
            >
              Open the conversation with @{approval.agent}
            </button>
          </div>
        ))}
        {notices.map((n) => (
          <NoticeCard
            key={n.kind === 'update' ? 'update' : `${n.kind}:${n.server.name}`}
            notice={n}
            onPostpone={onPostpone}
          />
        ))}
        {!approvals.length && !notices.length && (
          <div className="inbox-empty">
            <Icon name="check" size={20} />
            <span className="strong">Nothing needs you right now.</span>
            <span className="small muted">
              Writes that wait for your approval appear here and in the agent’s conversation. One
              left waiting is refused when its time runs out.
            </span>
          </div>
        )}
        {approvals.length > 0 && (
          <p className="small muted">
            What you approve is what is sent. A write left waiting is refused when its time runs
            out.
          </p>
        )}
      </div>
    </main>
  );
}

function NoticeCard({ notice: n, onPostpone }: { notice: Notice; onPostpone: () => void }) {
  const { act, setView, selectServer } = useApp();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const machines = (server: ServerState) => {
    selectServer(server.name);
    setView({ kind: 'settings', section: 'machines' });
  };
  let icon: IconName;
  let title: string;
  let detail: string;
  let actions: React.ReactNode;
  switch (n.kind) {
    case 'vault': {
      icon = 'lock';
      title = `The vault on ${where(n.server)} is locked`;
      detail =
        'Agents there cannot use your accounts until it is unlocked. Nothing was lost: a restart locks it.';
      const unlock = async () => {
        setBusy(true);
        const call = machineCall(n.server.name);
        const done = await act(async () => {
          const status = await call('setup.status');
          return call('setup.prepare', {
            runtime: status.preparedRuntimes?.[0] ?? 'codex',
            confirm: true,
          });
        }, 'Vault unlocked');
        setBusy(false);
        if (done) vaultUnlocked();
      };
      actions = (
        <button type="button" className="btn" disabled={busy} onClick={() => void unlock()}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      );
      break;
    }
    case 'connection':
      icon = 'server';
      title =
        n.server.status === 'needs-setup'
          ? `Anchi is not installed on ${where(n.server)} yet`
          : `Anchi cannot reach ${where(n.server)}`;
      detail =
        n.server.status === 'needs-setup'
          ? 'Install it from Machines to run agents there.'
          : sanitizeLine(
              n.server.error ?? 'It did not answer. Its agents keep their last known state.',
            );
      actions = (
        <button type="button" className="btn" onClick={() => machines(n.server)}>
          Open Machines
        </button>
      );
      break;
    case 'upgrade':
      icon = 'sparkle';
      title = `Anchi ${sanitizeLine(n.version)} is available for ${where(n.server)}`;
      detail = 'Upgrading keeps agents, history and accounts. It waits until no task is running.';
      actions = (
        <button type="button" className="btn" onClick={() => machines(n.server)}>
          Open Machines
        </button>
      );
      break;
    case 'update':
      icon = 'sparkle';
      title = `Anchi ${sanitizeLine(n.update.version)} is available for this app`;
      detail = `You are using ${sanitizeLine(n.update.currentVersion)}. Run anchi update in a terminal, then reopen Anchi after your tasks finish.`;
      actions = (
        <>
          <button type="button" className="btn btn-ghost" onClick={onPostpone}>
            Remind me tomorrow
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void act(() => window.anchi.openExternal(n.update.url))}
          >
            What’s new
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void window.anchi.copyUpdateCommand().then(
                () => setCopied(true),
                (err) => void act(() => Promise.reject(new Error(message(err)))),
              )
            }
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>
        </>
      );
      break;
  }
  return (
    <section className="notice" aria-label={title}>
      <span className="notice-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="col grow min0 gap-s">
        <span className="strong">{title}</span>
        <span className="small muted">{detail}</span>
      </span>
      <span className="row gap notice-actions">{actions}</span>
    </section>
  );
}
