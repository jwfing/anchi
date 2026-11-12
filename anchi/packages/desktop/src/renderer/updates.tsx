import { useEffect, useState } from 'react';
import type { ReleaseUpdate } from '../shared.ts';

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

/**
 * The newer release of this app, unless it was postponed, and the way to postpone it for a day.
 * The check itself runs in the main process.
 */
export function useDesktopUpdate(): [ReleaseUpdate | null, () => void] {
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
  const postpone = () => {
    if (!update) return;
    try {
      localStorage.setItem(snoozeKey(update.version), String(Date.now() + SNOOZE_MS));
    } catch {
      // Storage refused: it is still put away until the window reopens.
    }
    setUpdate(null);
  };
  return [update, postpone];
}
