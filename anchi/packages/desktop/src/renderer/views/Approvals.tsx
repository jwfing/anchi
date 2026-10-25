import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { Approval } from '@anchi/protocol';
import { useEffect, useState } from 'react';
import { useApp } from '../App.tsx';
import { call } from '../api.ts';
import { clock, secondsLeft } from '../format.ts';
import { Icon } from '../ui.tsx';

/** Re-renders every second, for countdowns. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A held write, drawn by the app from the daemon's record: what is asked, by whom and why, and
 * the full summary, before the two buttons. Agent text never draws this card.
 */
export function ApprovalCard({ approval: a, full }: { approval: Approval; full?: boolean }) {
  const { act } = useApp();
  const now = useNow();
  const [deciding, setDeciding] = useState(false);
  const left = secondsLeft(a.createdAt, a.timeout, now);
  const decide = async (allow: boolean) => {
    setDeciding(true);
    await act(() => call('approvals.decide', { id: a.id, allow }), allow ? 'approved' : 'denied');
    setDeciding(false);
  };
  return (
    <section
      className={`approval ${full ? 'approval-full' : ''}`}
      aria-label={`Approval for @${a.agent}`}
    >
      <div className="approval-head">
        <Icon name="shield" size={16} />
        <span>Approve a write by @{a.agent}?</span>
        <span className="approval-left">refused automatically in {clock(left)}</span>
      </div>
      <dl className="approval-grid">
        <dt>Connector</dt>
        <dd>
          {sanitizeLine(a.connector)} ({sanitizeLine(a.host)})
        </dd>
        <dt>Operation</dt>
        <dd className="mono">{sanitizeLine(a.operation)}</dd>
        <dt>Why held</dt>
        <dd>{sanitizeLine(a.reason)}</dd>
        <dt>Started by</dt>
        <dd className="mono">{sanitizeLine(a.origin)}</dd>
      </dl>
      <pre className="approval-summary">{sanitize(a.summary).slice(0, full ? 20_000 : 1500)}</pre>
      <div className="approval-actions">
        <button
          type="button"
          className="btn"
          disabled={deciding}
          onClick={() => void decide(false)}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={deciding}
          onClick={() => void decide(true)}
        >
          Approve
        </button>
      </div>
    </section>
  );
}

export function ApprovalsView() {
  const { model, setView } = useApp();
  const [chosen, setChosen] = useState<string | undefined>();
  const current = model.approvals.find((a) => a.id === chosen) ?? model.approvals[0];
  return (
    <main className="main split">
      <aside className="list" aria-label="Waiting for you">
        <span className="section-label pad">WAITING FOR YOU · {model.approvals.length}</span>
        {model.approvals.map((a) => (
          <button
            type="button"
            key={a.id}
            className={`list-row ${a.id === current?.id ? 'selected' : ''}`}
            onClick={() => setChosen(a.id)}
          >
            <span className="strong">{sanitizeLine(a.operation).slice(0, 60)}</span>
            <span className="small muted">
              @{a.agent} · {sanitizeLine(a.connector)}
            </span>
          </button>
        ))}
        <p className="small muted pad">
          A write you leave waiting is refused when its time runs out.
        </p>
      </aside>
      <section className="detail scroll">
        {current ? (
          <>
            <div className="trusted">
              <Icon name="shield" size={14} /> Drawn by Anchi from the held request. What you
              approve is what is sent.
            </div>
            <ApprovalCard approval={current} full />
            <button
              type="button"
              className="link pad"
              onClick={() => setView({ kind: 'agent', agentId: current.agent })}
            >
              Open @{current.agent}
            </button>
          </>
        ) : (
          <div className="empty">Nothing is waiting for your approval.</div>
        )}
      </section>
    </main>
  );
}
