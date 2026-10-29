import { sanitizeLine } from '@anchi/core/sanitize';
import type { TaskStatus } from '@anchi/protocol';
import { type KeyboardEvent, type Ref, useCallback, useState } from 'react';

export function runtimeName(runtime: string): string {
  switch (runtime) {
    case 'codex':
      return 'Codex';
    case 'claude-code':
      return 'Claude Code';
    case 'hermes':
      return 'Hermes';
    default:
      return sanitizeLine(runtime);
  }
}

const PATHS = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h14M13 6l6 6-6 6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  chevron: 'M9 6l6 6-6 6',
  check: 'M5 12l5 5L20 7',
  server: 'M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01',
  x: 'M6 6l12 12M18 6L6 18',
  down: 'M6 9l6 6 6-6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Status as a word with a colored dot: never color alone. */
export function StatusPill({ status, waiting }: { status: TaskStatus; waiting?: boolean }) {
  const tone = waiting ? 'approval' : status;
  return (
    <span className={`pill pill-${tone}`}>
      <span className="dot" />
      {waiting ? 'waiting for you' : STATUS_LABEL[status]}
    </span>
  );
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Agent text with its web links as buttons that open the browser; never HTML. */
export function Linked({ text }: { text: string }) {
  const parts: (string | { url: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    parts.push(text.slice(at, m.index), { url: m[0] });
    at = m.index! + m[0].length;
  }
  parts.push(text.slice(at));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <button
            key={i}
            type="button"
            className="link"
            onClick={() => void window.anchi.openExternal(p.url)}
          >
            {p.url}
          </button>
        ),
      )}
    </>
  );
}

/** A message box: Enter sends, Shift+Enter starts a new line. */
export function Composer({
  placeholder,
  label,
  disabled,
  hint,
  inputRef,
  onSend,
}: {
  placeholder: string;
  label: string;
  disabled?: boolean;
  hint?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  onSend: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    try {
      await onSend(value);
      setText('');
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <div className="composer-wrap">
      {hint && <div className="composer-hint">{hint}</div>}
      <label className="composer">
        <span className="sr-only">{label}</span>
        <textarea
          ref={inputRef}
          rows={2}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button
          type="button"
          className="send"
          aria-label={label}
          disabled={disabled || busy || !text.trim()}
          onClick={() => void send()}
        >
          <Icon name="send" size={16} />
        </button>
      </label>
    </div>
  );
}

/** Bounds of the task panel: the conversation beside it keeps at least `main` pixels. */
export const PANEL_WIDTH = { min: 320, main: 360, initial: 560 };
const PANEL_KEY = 'anchi.taskPanelWidth';

/** The panel width `want`, given its width `now` and the conversation's width beside it. */
export function clampWidth(want: number, now: number, mainWidth: number) {
  const max = now + mainWidth - PANEL_WIDTH.main;
  return Math.round(Math.max(PANEL_WIDTH.min, Math.min(want, max)));
}

/** The task panel's width, remembered in this window's storage when it allows it. */
export function usePanelWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_KEY));
      return saved >= PANEL_WIDTH.min ? saved : PANEL_WIDTH.initial;
    } catch {
      return PANEL_WIDTH.initial;
    }
  });
  const save = useCallback((next: number) => {
    setWidth(next);
    try {
      localStorage.setItem(PANEL_KEY, String(next));
    } catch {
      // Storage refused: the width lasts until the window closes.
    }
  }, []);
  return [width, save];
}

/**
 * The drawer's left edge. Resizing leaves part of the task list visible for switching tasks;
 * a double-click restores the default.
 */
export function Splitter({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const drawerWidth = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? width;
  const mainWidth = (el: HTMLElement) =>
    (el.parentElement?.parentElement?.getBoundingClientRect().width ?? width) - drawerWidth(el);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task details"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH.min}
      tabIndex={0}
      className="splitter"
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        const [x, start, main] = [e.clientX, drawerWidth(el), mainWidth(el)];
        el.setPointerCapture(e.pointerId);
        const move = (m: PointerEvent) => onResize(clampWidth(start + x - m.clientX, start, main));
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
        if (!step) return;
        e.preventDefault();
        const now = drawerWidth(e.currentTarget);
        onResize(clampWidth(now + step, now, mainWidth(e.currentTarget)));
      }}
      onDoubleClick={(e) =>
        onResize(
          clampWidth(PANEL_WIDTH.initial, drawerWidth(e.currentTarget), mainWidth(e.currentTarget)),
        )
      }
    />
  );
}

export function Avatar({ id, size = 34 }: { id: string; size?: number }) {
  // Soft classical tints: 藕荷, 天青, 竹青, 杏, 月白, 蜜合.
  const tints = ['#E9DFE3', '#DCE5EA', '#E0E8DC', '#F1E4D3', '#E6E9EA', '#ECE5CF'];
  const hash = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: tints[hash % tints.length] }}
    >
      {id.slice(0, 1).toUpperCase()}
    </span>
  );
}
