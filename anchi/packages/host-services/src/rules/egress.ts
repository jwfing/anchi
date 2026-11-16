import { hostMatches } from './decide.ts';
import { BASE_EGRESS, type Rule } from './table.ts';

/**
 * A session with an egress list reaches only those hosts, plus what its connectors need.
 * Without a list, egress stays open (any public host).
 */

export const EGRESS_PATTERN = /^(\*\.)?[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/**
 * The allowed host patterns, or null for open egress. `extra` holds the hosts of rules that
 * depend on stored settings (the Hermes endpoint).
 */
export function egressAllowlist(
  patterns: readonly string[] | null,
  grants: Iterable<string>,
  extra: readonly Rule[] = [],
): ReadonlySet<string> | null {
  if (patterns === null) return null;
  const allowed = new Set(patterns.map((p) => p.toLowerCase()));
  for (const grant of grants) for (const host of BASE_EGRESS[grant] ?? []) allowed.add(host);
  for (const rule of extra) for (const host of rule.hosts) allowed.add(host);
  return allowed;
}

export function egressAllowed(allowlist: ReadonlySet<string> | null, host: string): boolean {
  if (allowlist === null) return true;
  for (const pattern of allowlist) if (hostMatches(pattern, host)) return true;
  return false;
}
