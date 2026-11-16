import { z } from 'zod';
import { EGRESS_PATTERN } from '../rules/egress.ts';

/**
 * The control socket's operations: one JSON line in, one JSON line out (`approvals.watch`
 * streams lines until the client leaves). The daemon is the only caller; it proves it can read
 * the user's files with the token the process wrote beside the socket. Every field from the
 * daemon is validated here before a handler sees it, as the Python proxy's `validate` did.
 */

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PROXY_CONNECTORS = [
  'github',
  'aws',
  'linear',
  'posthog',
  'sentry',
  'firecrawl',
  'figma',
  'discord',
] as const;
export type ProxyConnector = (typeof PROXY_CONNECTORS)[number];
export const APPROVAL_ID = /^[0-9a-f]{16}$/;
/** Largest request line the control socket reads. */
export const CONTROL_MAX = 64 * 1024;

const connector = z.enum(PROXY_CONNECTORS);
const token = z.string().regex(/^[0-9a-f]{64}$/);

export const registerSchema = z.strictObject({
  op: z.literal('register'),
  token,
  connectors: z.array(connector).max(PROXY_CONNECTORS.length),
  ask: z.array(connector).max(PROXY_CONNECTORS.length).default([]),
  high_risk_disabled: z
    .array(z.string().regex(/^[a-z0-9-]{1,40}$/))
    .max(30)
    .default([]),
  egress: z.array(z.string().regex(EGRESS_PATTERN)).max(100).nullable().default(null),
  listen_port: z.number().int().min(1024).max(65535),
});

export const requestSchema = z.discriminatedUnion('op', [
  registerSchema,
  z.strictObject({ op: z.literal('unregister'), token }),
  z.strictObject({ op: z.literal('list'), token }),
  z.strictObject({ op: z.literal('version'), token }),
  z.strictObject({ op: z.literal('quota'), token }),
  z.strictObject({
    op: z.literal('settings.set'),
    token,
    settings: z.strictObject({
      high_risk_disabled: z
        .array(z.string().regex(/^[a-z0-9-]{1,40}$/))
        .max(60)
        .default([]),
      approval_timeout_s: z.number().int().min(60).max(43_200).optional(),
    }),
  }),
  z.strictObject({ op: z.literal('approvals.watch'), token }),
  z.strictObject({
    op: z.literal('approvals.decide'),
    token,
    id: z.string().regex(APPROVAL_ID),
    allow: z.boolean(),
  }),
  z.strictObject({ op: z.literal('verify'), token, connector }),
  z.strictObject({ op: z.literal('vault.status'), token }),
  z.strictObject({
    op: z.literal('vault.unlock'),
    token,
    key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  }),
  z.strictObject({ op: z.literal('vault.lock'), token }),
  z.strictObject({ op: z.literal('credentials.status'), token }),
  z.strictObject({
    op: z.literal('credentials.import'),
    token,
    connector: z.enum(PROXY_CONNECTORS.filter((c) => c !== 'aws') as [ProxyConnector]),
    value: z.string().min(1).max(1000),
  }),
  z.strictObject({
    op: z.literal('credentials.importAws'),
    token,
    access_key_id: z.string().min(1).max(200),
    secret_access_key: z.string().min(1).max(200),
    session_token: z.string().min(1).max(4096).optional(),
    region: z.string().min(1).max(40),
  }),
  z.strictObject({ op: z.literal('credentials.remove'), token, connector }),
  z.strictObject({
    op: z.literal('credentials.setAccount'),
    token,
    connector,
    label: z.string().min(1).max(200),
  }),
]);

export type ControlRequest = z.infer<typeof requestSchema>;
/** What a caller writes: the defaults may be left out. */
export type ControlInput = z.input<typeof requestSchema>;
export type ControlOp = ControlRequest['op'];
/** Every operation the protocol knows; a request naming another is `UNKNOWN_OP`. */
export const CONTROL_OPS: ReadonlySet<string> = new Set(
  requestSchema.options.map((option) => option.shape.op.value),
);

/** What `approvals.watch` streams: the Python proxy's lines, which the daemon already reads. */
export type WatchEvent =
  | { type: 'pending'; approval: ApprovalItem }
  | { type: 'resolved'; id: string }
  | { type: 'notice'; task: string; text: string }
  | {
      type: 'credential';
      task: string;
      agent: string;
      method: string;
      host: string;
      path: string;
    }
  | { type: 'ping' };

export interface ApprovalItem {
  id: string;
  task: string;
  agent: string;
  connector: string;
  operation: string;
  host: string;
  summary: string;
  reason: string;
  created_at: number;
  timeout: number;
}

export type ControlResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** A refusal with a stable code; the message never carries request contents. */
export class ControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ControlError';
  }
}
