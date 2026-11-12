import { useState } from 'react';
import { Markdown } from '../markdown.tsx';
import { type Item, toolSummary } from '../transcript.ts';
import { Linked } from '../ui.tsx';

/** One transcript entry: a tool group opens to its calls and their results. */
export function TranscriptItem({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'input':
      return (
        <div className="t-input">
          › <Linked text={item.text} />
        </div>
      );
    case 'message':
      return (
        <div className="t-message">
          <Markdown text={item.text} />
        </div>
      );
    case 'progress':
      return <div className="t-progress">✻ {item.text}</div>;
    case 'notice':
      return <div className="t-notice">ℹ {item.text}</div>;
    case 'error':
      return (
        <div className="t-error">
          {item.fatal ? '✗' : '!'} {item.text}
        </div>
      );
    case 'tools':
      return (
        <div className="t-tools">
          <button
            type="button"
            className="tools"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? '▾' : '▸'} {toolSummary(item.calls)}
          </button>
          {open &&
            item.calls.map((c) => (
              <div key={c.id} className="t-call">
                <div className="mono small">
                  ▸ {c.name} {c.input.slice(0, 600)}
                </div>
                {c.output !== undefined && (
                  <div className={`mono small t-output ${c.isError ? 't-output-error' : ''}`}>
                    ⎿ {c.output.slice(0, 1200)}
                  </div>
                )}
              </div>
            ))}
        </div>
      );
  }
}
