import { z } from 'zod';
import { delegateRefSchema } from './agent-ref.ts';
import { runtimeEventSchema } from './events.ts';

const agentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const taskId = z.string().regex(/^t-[0-9a-f]{10}$/);
const nodeId = z.string().regex(/^[0-9a-f]{32}$/);
const workerId = agentId.refine((id) => id !== 'builder', 'builder cannot be a remote worker');

/** A logical team member executes as an existing agent on a saved server. */
export const executionSchema = z.strictObject({
  server: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,39}$/)
    .refine((s) => !['local', 'ls', 'add', 'rm'].includes(s)),
  agent: workerId,
});
export type Execution = z.infer<typeof executionSchema>;

export const teamOriginSchema = z.strictObject({
  coordinator: nodeId,
  task: taskId,
  agent: agentId,
  chain: z.array(z.string().min(1).max(200)).min(1).max(5),
});
export type TeamOrigin = z.infer<typeof teamOriginSchema>;

export const teamKeySchema = z.strictObject({ coordinator: nodeId, task: taskId });
export type TeamKey = z.infer<typeof teamKeySchema>;
export const teamCancelSchema = teamKeySchema.extend({
  turn: z.number().int().min(1).max(100_000),
});
export const teamRunSchema = z.strictObject({
  origin: teamOriginSchema,
  agent: workerId,
  turn: z.number().int().min(1).max(100_000),
  text: z.string().min(1).max(200_000),
});
export type TeamRun = z.infer<typeof teamRunSchema>;

export const teamPollSchema = teamKeySchema.extend({ afterSeq: z.number().int().nonnegative() });
export const teamReplySchema = teamKeySchema.extend({
  request: z.string().regex(/^[0-9a-f]{32}$/),
  outcome: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('result'), value: z.record(z.string(), z.unknown()) }),
    z.strictObject({ kind: z.literal('error'), message: z.string().max(2000) }),
  ]),
});
export type TeamReply = z.infer<typeof teamReplySchema>;

export const teamToolSchema = z
  .strictObject({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    turn: z.number().int().positive(),
    tool: z.string().min(1).max(100),
    args: z.record(z.string(), z.unknown()),
  })
  .refine(
    (request) => JSON.stringify(request.args).length <= 64_000,
    'team arguments are too large',
  );
export type TeamTool = z.infer<typeof teamToolSchema>;

export const teamApprovalSchema = z.strictObject({
  id: z.string().min(1).max(40),
  kind: z.enum(['proxy', 'policy']),
  task: taskId,
  agent: agentId,
  connector: z.string().max(100),
  operation: z.string().max(1000),
  host: z.string().max(1000),
  summary: z.string().max(200_000),
  createdAt: z.number().finite(),
  timeout: z.number().nonnegative().max(43_200),
  reason: z.string().max(2000),
  origin: z.string().max(2000),
});

/** Only the bounded fields a coordinator needs cross the execution transport. */
export const teamSnapshotSchema = z.strictObject({
  task: z.strictObject({
    id: taskId,
    status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']),
    runtime: z.string().max(100).nullable(),
    result: z.string().max(8000).nullable(),
    turns: z.number().int().nonnegative(),
  }),
  events: z
    .array(
      z.strictObject({
        seq: z.number().int().positive(),
        ts: z.number(),
        event: runtimeEventSchema,
      }),
    )
    .max(500),
  requests: z.array(teamToolSchema).max(200),
  approvals: z.array(teamApprovalSchema).max(100),
});
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;

export const teamDescribeSchema = z.strictObject({
  node: nodeId,
  agent: workerId,
  name: z.string().max(100),
  description: z.string().max(500),
  runtime: z.enum(['codex', 'claude-code', 'hermes']),
  delegates: z.array(delegateRefSchema).max(50),
  connectors: z.array(z.string().max(100)).max(50),
  skills: z.array(agentId).max(200),
});
export type TeamDescription = z.infer<typeof teamDescribeSchema>;
