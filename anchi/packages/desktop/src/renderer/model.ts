import type {
  AgentSummary,
  Approval,
  BuilderProposal,
  RuntimeEvent,
  StoredEvent,
  TaskRow,
} from '@anchi/protocol';

/** Everything the window shows that comes from the daemon. */
export interface Model {
  agents: AgentSummary[];
  tasks: Record<string, TaskRow>;
  /** Stored events per task, ascending by seq, for tasks whose transcript was loaded. */
  events: Record<string, StoredEvent[]>;
  approvals: Approval[];
  /** Builder proposals waiting for a decision, by the agent they create or change. */
  proposals: Record<string, BuilderProposal>;
}

export const EMPTY_MODEL: Model = {
  agents: [],
  tasks: {},
  events: {},
  approvals: [],
  proposals: {},
};

export type Action =
  | { type: 'agents'; agents: AgentSummary[] }
  | { type: 'tasks'; tasks: TaskRow[]; replace?: boolean }
  | { type: 'events'; taskId: string; events: StoredEvent[] }
  | { type: 'event'; taskId: string; seq?: number; event: RuntimeEvent; ts: number }
  | { type: 'approvals'; approvals: Approval[] }
  | { type: 'proposal'; proposal: BuilderProposal }
  | { type: 'proposalDone'; proposalId: string };

/** Adds events after the last one known; repeats and out-of-order pages are dropped. */
function append(known: StoredEvent[] | undefined, more: StoredEvent[]): StoredEvent[] {
  const list = known ? [...known] : [];
  let last = list.at(-1)?.seq ?? 0;
  for (const e of more) {
    if (e.seq > last) {
      list.push(e);
      last = e.seq;
    }
  }
  return list;
}

export function reduce(model: Model, action: Action): Model {
  switch (action.type) {
    case 'agents':
      return { ...model, agents: action.agents };
    case 'tasks': {
      const tasks = action.replace ? {} : { ...model.tasks };
      for (const t of action.tasks) tasks[t.id] = t;
      return { ...model, tasks };
    }
    case 'events':
      return {
        ...model,
        events: {
          ...model.events,
          [action.taskId]: append(model.events[action.taskId], action.events),
        },
      };
    case 'event': {
      // Streaming deltas carry no seq and are not stored; only transcripts already loaded grow
      // (one not loaded yet is read in full when it is opened).
      const known = model.events[action.taskId];
      if (action.seq === undefined || !known) return model;
      const stored = { seq: action.seq, ts: action.ts, event: action.event };
      return { ...model, events: { ...model.events, [action.taskId]: append(known, [stored]) } };
    }
    case 'approvals':
      return { ...model, approvals: action.approvals };
    case 'proposal':
      return {
        ...model,
        proposals: { ...model.proposals, [action.proposal.agentId]: action.proposal },
      };
    case 'proposalDone': {
      const proposals = Object.fromEntries(
        Object.entries(model.proposals).filter(([, p]) => p.id !== action.proposalId),
      );
      return { ...model, proposals };
    }
  }
}

/** An agent's tasks, oldest first, as a conversation reads. */
export function agentTasks(model: Model, agentId: string): TaskRow[] {
  return Object.values(model.tasks)
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** What the sidebar says an agent is doing. */
export function agentActivity(
  model: Model,
  agent: AgentSummary,
): { tone: 'working' | 'approval' | 'idle' | 'queued' | 'error'; text: string } {
  if (agent.error) return { tone: 'error', text: `Needs attention: ${agent.error}` };
  const waiting = model.approvals.filter((a) => a.agent === agent.id).length;
  if (waiting) return { tone: 'approval', text: `Waiting for your approval (${waiting})` };
  if (agent.running) return { tone: 'working', text: `${agent.running} running` };
  if (agent.queued) return { tone: 'queued', text: `${agent.queued} queued` };
  const last = agentTasks(model, agent.id).at(-1);
  if (last?.status === 'failed') return { tone: 'error', text: `Failed: ${last.title}` };
  if (last) return { tone: 'idle', text: `Last: ${last.title}` };
  return { tone: 'idle', text: agent.description ?? 'No tasks yet' };
}
