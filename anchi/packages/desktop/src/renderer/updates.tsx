import { useEffect, useState } from 'react';
import type { ReleaseUpdate } from '../shared.ts';
import { Icon } from './ui.tsx';

const SNOOZE_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (version: string) => `anchi.update.remindAfter:${version}`;

export function updateSnoozed(version: string, now = Date.now()): boolean {
  try {
    const until = Number(localStorage.getItem(snoozeKey(version)));
    return Number.isFinite(until) && until > now && until <= now + SNOOZE_MS;
  } catch {
    return false;
  }
}

export function DesktopUpdates() {
  const [update, setUpdate] = useState<ReleaseUpdate | null>(null);
  useEffect(() => {
    let current = true;
    let notified = false;
    const receive = (next: ReleaseUpdate | null) => {
      if (current) setUpdate(next && !updateSnoozed(next.version) ? next : null);
    };
    const off = window.anchi.onUpdate((next) => {
      notified = true;
      receive(next);
    });
    void window.anchi
      .update()
      .then((next) => {
        if (!notified) receive(next);
      })
      .catch(() => {});
    return () => {
      current = false;
      off();
    };
  }, []);
  if (!update) return null;
  return (
    <UpdateNotice
      key={update.version}
      update={update}
      onDismiss={() => {
        try {
          localStorage.setItem(snoozeKey(update.version), String(Date.now() + SNOOZE_MS));
        } catch {
          // Storage refused: dismissal still closes the current notice.
        }
        setUpdate(null);
      }}
    />
  );
}

export function UpdateNotice({ update, onDismiss }: { update: ReleaseUpdate; onDismiss(): void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  return (
    <aside className="update-notice" role="dialog" aria-labelledby="update-title">
      <div className="row between">
        <div className="row">
          <span className="update-icon">
            <Icon name="sparkle" size={22} />
          </span>
          <div>
            <h2 id="update-title">Anchi {update.version} is available</h2>
            <p className="small muted">You’re using {update.currentVersion}</p>
          </div>
        </div>
        <button
          className="btn btn-small update-close"
          aria-label="Remind me tomorrow"
          onClick={onDismiss}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <p className="small">Update in Terminal, then reopen Anchi after your tasks finish.</p>
      <div className="update-command">
        <code>anchi update</code>
        <button
          className="btn btn-small"
          onClick={() => {
            void window.anchi
              .copyUpdateCommand()
              .then(() => setCopied(true))
              .catch(() => setError('Could not copy. Select the command above to copy it.'));
          }}
        >
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </div>
      <div className="row between">
        <button
          className="link small"
          onClick={() => {
            void window.anchi
              .openExternal(update.url)
              .catch(() => setError('Could not open the release page. Try again.'));
          }}
        >
          What’s new
        </button>
        <button className="btn btn-small" onClick={onDismiss}>
          Remind me tomorrow
        </button>
      </div>
      {error && (
        <p className="small tone-error" role="status">
          {error}
        </p>
      )}
    </aside>
  );
}
