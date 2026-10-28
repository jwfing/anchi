import { sanitizeLine } from '@anchi/core/sanitize';
import type { AgentDeletion, AgentDeletionPreview } from '@anchi/protocol';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../App.tsx';
import { message } from '../api.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; error: string }
  | { kind: 'review'; preview: AgentDeletionPreview; error?: string }
  | { kind: 'deleting'; preview: AgentDeletionPreview }
  | { kind: 'done'; result: AgentDeletion };

export function DeleteAgentAction({ agentId }: { agentId: string }) {
  const { deleteAgent } = useApp();
  if (agentId === 'builder') return null;
  return (
    <section className="card">
      <h2>Delete agent</h2>
      <p className="small muted">
        Remove this agent and its task history. Review the affected data before deleting.
      </p>
      <button type="button" className="btn btn-danger" onClick={() => deleteAgent(agentId)}>
        Delete agent…
      </button>
    </section>
  );
}

/** Kept outside the agent view so cleanup warnings survive the agent disappearing from Team. */
export function DeleteAgentDialog({ agentId, onClose }: { agentId: string; onClose(): void }) {
  const { server, call } = useApp();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [typed, setTyped] = useState('');
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const busy = state.kind === 'deleting';
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let active = true;
    void call('agents.deletePreview', { agentId }).then(
      (preview) => active && setState({ kind: 'review', preview }),
      (err) => active && setState({ kind: 'failed', error: message(err) }),
    );
    return () => {
      active = false;
    };
  }, [agentId, call, attempt]);
  const reload = useCallback(() => {
    setTyped('');
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  const remove = async () => {
    if (state.kind !== 'review' || typed !== agentId) return;
    const { preview } = state;
    setState({ kind: 'deleting', preview });
    try {
      const result = await call('agents.delete', { agentId, confirm: typed });
      setState({ kind: 'done', result });
    } catch (err) {
      setState({ kind: 'review', preview, error: message(err) });
    }
  };
  return (
    <dialog
      ref={dialog}
      className="agent-delete-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={title}>
        {state.kind === 'done' ? 'Agent removed' : `Delete @${sanitizeLine(agentId)}?`}
      </h2>
      <p className="small muted">
        Machine: {sanitizeLine(server.label)} ({sanitizeLine(server.name)})
      </p>
      {state.kind === 'loading' && <p>Loading deletion preview…</p>}
      {state.kind === 'failed' && (
        <div className="banner banner-error">{sanitizeLine(state.error)}</div>
      )}
      {(state.kind === 'review' || state.kind === 'deleting') && (
        <>
          <DeletionDetails preview={state.preview} />
          {state.kind === 'review' && state.error && (
            <div className="banner banner-error">{sanitizeLine(state.error)}</div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            <label className="field">
              <span className="small strong">Type {sanitizeLine(agentId)} to confirm</span>
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="agent-delete-actions">
              <button type="button" className="btn" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              {state.kind === 'review' && state.error && (
                <button type="button" className="btn" onClick={reload}>
                  Refresh preview
                </button>
              )}
              <button type="submit" className="btn btn-danger" disabled={busy || typed !== agentId}>
                {busy ? 'Deleting…' : 'Continue to confirmation'}
              </button>
            </div>
          </form>
        </>
      )}
      {state.kind === 'done' && (
        <>
          <p>
            @{sanitizeLine(agentId)} was removed. {state.result.deletedTasks} tasks and their
            transcripts were deleted.
          </p>
          {state.result.warnings.map((warning, i) => (
            <p key={i} className="banner banner-warn">
              {sanitizeLine(warning)}
            </p>
          ))}
          <div className="agent-delete-actions">
            {state.result.warnings.length > 0 && (
              <button type="button" className="btn" onClick={reload}>
                Review remaining cleanup
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
      {(state.kind === 'loading' || state.kind === 'failed') && (
        <div className="agent-delete-actions">
          {state.kind === 'failed' && (
            <button type="button" className="btn" onClick={reload}>
              Retry preview
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </dialog>
  );
}

export function DeletionDetails({ preview: p }: { preview: AgentDeletionPreview }) {
  return (
    <>
      <p>This permanently deletes:</p>
      <ul>
        <li>
          {p.exists
            ? 'The agent configuration.'
            : 'Any remaining agent data (its configuration is already gone).'}
        </li>
        <li>
          {p.tasks} tasks and {p.delegated} delegated tasks, including their transcripts.
        </li>
        <li>{p.triggers} triggers and their stored state.</li>
        <li>Its VM home, working files, runtime sessions, installed skills and policy rules.</li>
      </ul>
      {p.running > 0 && (
        <p className="banner banner-warn">
          {p.running} running or queued tasks will be cancelled first.
        </p>
      )}
      {(p.delegatedBy.length > 0 || p.delegatedByTemplates.length > 0) && (
        <p>
          Remove delegation references from{' '}
          {[
            ...p.delegatedBy.map((id) => `@${id}`),
            ...p.delegatedByTemplates.map((id) => `template ${id}`),
          ]
            .map(sanitizeLine)
            .join(', ')}
          .
        </p>
      )}
      <p>
        Workspaces{p.workspaces.length ? ` (${p.workspaces.map(sanitizeLine).join(', ')})` : ''} and
        audit logs are kept. This cannot be undone.
      </p>
    </>
  );
}
