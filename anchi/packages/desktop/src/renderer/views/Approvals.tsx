import { sanitize, sanitizeLine } from '@anchi/core/sanitize';
import type { Approval } from '@anchi/protocol';
import { useEffect, useState } from 'react';
import { useApp } from '../App.tsx';
import type { Call } from '../api.ts';
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
 * A held write, drawn by the app from the daemon's record under a band agent text cannot draw:
 * what is asked, by whom and why, and the full summary, before the two buttons. `call` binds the
 * decision to the machine that holds the write when the card is shown outside that machine's view.
 */
export function ApprovalCard({
  approval: a,
  full,
  call: bound,
  machine,
}: {
  approval: Approval;
  full?: boolean;
  call?: Call;
  /** Named in the band when several machines are connected. */
  machine?: string;
}) {
  const app = useApp();
  const call = bound ?? app.call;
  const now = useNow();
  const [deciding, setDeciding] = useState(false);
  const left = secondsLeft(a.createdAt, a.timeout, now);
  const decide = async (allow: boolean) => {
    setDeciding(true);
    await app.act(
      () => call('approvals.decide', { id: a.id, allow }),
      allow ? 'approved' : 'denied',
    );
    setDeciding(false);
  };
  return (
    <section
      className={`approval ${full ? 'approval-full' : ''}`}
      aria-label={`Approval for @${a.agent}`}
    >
      <div className="approval-band">
        <Icon name="shield" size={14} />
        <span className="approval-band-title">Anchi · needs your approval</span>
        {machine && <span className="approval-machine">on {sanitizeLine(machine)}</span>}
        <span className="approval-left">refused automatically in {clock(left)}</span>
      </div>
      <div className="approval-body">
        <div className="approval-head">Approve a write by @{a.agent}?</div>
        <dl className="approval-grid">
          <dt>Where</dt>
          <dd>
            {sanitizeLine(a.connector)} ({sanitizeLine(a.host)})
          </dd>
          <dt>What</dt>
          <dd className="mono">{sanitizeLine(a.operation)}</dd>
          <dt>Why you’re asked</dt>
          <dd>{sanitizeLine(a.reason)}</dd>
          <dt>Asked by</dt>
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
      </div>
    </section>
  );
}
