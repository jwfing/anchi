import { z } from 'zod';

export const peerNodeSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const peerAgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const peerAgentRefSchema = z
  .string()
  .regex(/^[0-9a-f]{32}\/[a-z0-9][a-z0-9-]{0,39}\/[0-9a-f]{16}$/);
export const delegateRefSchema = z.union([peerAgentIdSchema, peerAgentRefSchema]);
