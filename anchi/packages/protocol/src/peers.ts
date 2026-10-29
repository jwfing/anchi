import { z } from 'zod';
import { teamSnapshotSchema, teamApprovalSchema } from './team.ts';

import {
  peerNodeSchema,
  peerAgentIdSchema,
  peerAgentRefSchema,
  delegateRefSchema,
} from './agent-ref.ts';
export {
  peerNodeSchema,
  peerAgentIdSchema,
  peerAgentRefSchema,
  delegateRefSchema,
} from './agent-ref.ts';
export const peerAddressSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'tls:' &&
        !!url.hostname &&
        /^\d+$/.test(url.port) &&
        Number(url.port) <= 65535 &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!url.pathname || url.pathname === '/')
      );
    } catch {
      return false;
    }
  }, 'use tls://hostname:port, reachable from the other machines');
export const peerNetworkConfigSchema = z.strictObject({
  label: z.string().min(1).max(80),
  listen: z
    .string()
    .max(80)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(0).max(65535),
  address: peerAddressSchema,
});
export type PeerNetworkConfig = z.infer<typeof peerNetworkConfigSchema>;
export const peerAgentSchema = z.strictObject({
  id: peerAgentIdSchema,
  generation: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string().max(100),
  description: z.string().max(500),
  runtime: z.string().max(40),
  connectors: z.array(z.string().max(40)).max(50),
  skills: z.array(z.string().max(40)).max(200),
});
export type PeerAgent = z.infer<typeof peerAgentSchema>;
export const peerRecordSchema = z
  .strictObject({
    node: peerNodeSchema,
    label: z.string().min(1).max(80),
    address: peerAddressSchema,
    certificate: z.string().max(8000),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    agents: z.array(peerAgentSchema).max(200),
    signature: z.string().min(1).max(300),
  })
  .refine(
    (record) => new TextEncoder().encode(JSON.stringify(record)).byteLength <= 2_000_000,
    'peer catalog is too large',
  );
export type PeerRecord = z.infer<typeof peerRecordSchema>;
export const peerSyncSchema = z.strictObject({
  records: z.array(peerRecordSchema).max(32),
  removed: z.array(peerNodeSchema).max(1000),
});
export type PeerDirectory = {
  self: string;
  configured: boolean;
  config?: PeerNetworkConfig;
  nodes: (Omit<PeerRecord, 'signature' | 'certificate'> & { online: boolean })[];
};

export const peerTaskRefSchema = z.strictObject({
  node: peerNodeSchema,
  task: z.string().regex(/^t-[0-9a-f]{10}$/),
});
export type PeerTaskRef = z.infer<typeof peerTaskRefSchema>;
export const peerTaskInfoSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('execution'),
    root: peerTaskRefSchema,
    parent: peerTaskRefSchema.nullable(),
    lineage: z.array(peerAgentRefSchema).min(1).max(4),
  }),
  z.strictObject({
    kind: z.literal('mirror'),
    node: peerNodeSchema,
    agent: peerAgentRefSchema,
    remoteTask: z
      .string()
      .regex(/^t-[0-9a-f]{10}$/)
      .nullable(),
    observed: z.boolean().optional(),
    root: peerTaskRefSchema,
  }),
]);
export type PeerTaskInfo = z.infer<typeof peerTaskInfoSchema>;
export const peerBudgetSchema = z
  .strictObject({
    start: z.number().int().min(0).max(60),
    end: z.number().int().min(0).max(60),
  })
  .refine((b) => b.start <= b.end, 'invalid task budget');
export type PeerBudget = z.infer<typeof peerBudgetSchema>;
export const peerDispatchSchema = z.strictObject({
  request: z.string().regex(/^t-[0-9a-f]{10}$/),
  parent: peerTaskRefSchema.nullable(),
  root: peerTaskRefSchema,
  target: peerAgentRefSchema,
  lineage: z.array(peerAgentRefSchema).min(1).max(4),
  budget: peerBudgetSchema,
  turn: z.number().int().min(1).max(60),
  text: z.string().min(1).max(200_000),
});
export type PeerDispatch = z.infer<typeof peerDispatchSchema>;
export const peerJobKeySchema = z.strictObject({ request: z.string().regex(/^t-[0-9a-f]{10}$/) });

export const peerPollSchema = peerJobKeySchema.extend({ afterSeq: z.number().int().nonnegative() });
export const peerCancelSchema = peerJobKeySchema.extend({ turn: peerDispatchSchema.shape.turn });
export const peerApproveSchema = peerJobKeySchema.extend({
  id: z.string().min(1).max(40),
  allow: z.boolean(),
});
export const peerSnapshotSchema = z.strictObject({
  task: teamSnapshotSchema.shape.task,
  events: teamSnapshotSchema.shape.events,
  nextSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  approvals: z.array(teamApprovalSchema.extend({ agent: delegateRefSchema })).max(100),
  descendants: z
    .array(
      z.strictObject({
        id: peerTaskRefSchema.shape.task,
        parent: peerTaskRefSchema.shape.task,
        agent: peerAgentRefSchema,
        title: z.string().max(120),
        status: teamSnapshotSchema.shape.task.shape.status,
        result: z.string().max(8000).nullable(),
        turns: z.number().int().min(0).max(60),
      }),
    )
    .max(59),
});
export type PeerSnapshot = z.infer<typeof peerSnapshotSchema>;
