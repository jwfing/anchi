import { sanitizeLine } from '@anchi/core/sanitize';
import type { AgentSettingValues, FixedSettings } from '@anchi/protocol';

/** One line of what an agent can or cannot reach. `warn` marks reach that skips an approval. */
export interface AccessLine {
  can: boolean;
  text: string;
  warn?: boolean;
}

/**
 * An agent's settings as a list of what it can and cannot reach, for someone who does not read
 * agent files. Every line follows from a setting: nothing is promised that the settings do not
 * say. `name` turns a connector id into what the user calls it.
 */
export function plainWords(
  values: Pick<
    AgentSettingValues,
    'connectors' | 'workspaces' | 'delegates' | 'highRisk' | 'approvals' | 'triggers'
  >,
  fixed: Pick<FixedSettings, 'approvals' | 'egress' | 'sandbox' | 'delegates' | 'highRiskGlobal'>,
  name: (connector: string) => string = (id) => id,
): AccessLine[] {
  const lines: AccessLine[] = [];
  for (const id of values.connectors) {
    // The draft's approvals when the daemon sends them; an older one only has the fixed map.
    const mode = (values.approvals ?? fixed.approvals)[id];
    lines.push({
      can: true,
      text:
        mode === 'ask'
          ? `Acts through ${name(id)}; anything that writes waits for you`
          : `Acts through ${name(id)}; high-risk operations wait for you`,
    });
  }
  for (const w of values.workspaces) {
    lines.push({
      can: true,
      text: `${w.mode === 'rw' ? 'Reads and changes' : 'Reads'} files in ${sanitizeLine(w.path)}`,
      warn: w.mode === 'rw',
    });
  }
  const delegates = values.delegates ?? fixed.delegates;
  if (delegates.length) {
    lines.push({
      can: true,
      text: `Hands work to ${delegates.map((d) => `@${sanitizeLine(d)}`).join(', ')}`,
    });
  }
  lines.push(
    fixed.egress === null
      ? { can: true, text: 'Reaches any public website' }
      : fixed.egress.length
        ? { can: true, text: `Reaches only ${fixed.egress.map(sanitizeLine).join(', ')}` }
        : { can: false, text: 'Cannot reach any website of its own choosing' },
  );
  const triggers = values.triggers?.length ?? 0;
  if (triggers) {
    lines.push({
      can: true,
      warn: true,
      text: `Starts tasks by itself: ${triggers} ${triggers === 1 ? 'schedule' : 'schedules'}`,
    });
  }
  const exempt = [...new Set([...values.highRisk.disable, ...(fixed.highRiskGlobal ?? [])])];
  if (exempt.length) {
    lines.push({
      can: true,
      warn: true,
      text: `Does without asking: ${exempt.map(sanitizeLine).join(', ')}`,
    });
  }
  lines.push({
    can: false,
    text: values.workspaces.length
      ? 'Cannot read files outside the shared folders'
      : 'Cannot read any file on this computer',
  });
  lines.push({
    can: false,
    text: values.connectors.length
      ? 'Cannot use an account that is not switched on here'
      : 'Cannot use any of your connected accounts',
  });
  if (!delegates.length) lines.push({ can: false, text: 'Cannot hand work to another agent' });
  lines.push({
    can: false,
    text: 'Never sees a password or token: Anchi adds them outside its cell',
  });
  if (fixed.sandbox !== 'cell') {
    lines.push({
      can: true,
      text: `Runs with an extra sandbox inside its cell (${sanitizeLine(fixed.sandbox)})`,
    });
  }
  return lines;
}
