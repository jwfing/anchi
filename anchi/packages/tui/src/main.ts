#!/usr/bin/env -S node --import tsx
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { styleText } from 'node:util';
import { homeLayout } from '@anchi/core';
import {
  connectOrStart,
  type DaemonClient,
  installAutostart,
  tryConnect,
  uninstallAutostart,
  REPO_ROOT,
} from '@anchi/daemon';
import type { ConnectorId, ConnectorSecret, SetupAction, TaskRow } from '@anchi/protocol';
import { Command } from 'commander';
import { TerminalRenderer } from './render.ts';
import { sanitizeLine } from './sanitize.ts';
import { selfUpdate } from './update.ts';
import { runTui } from './tui/index.tsx';
import { loadKeyMap } from './tui/keyconfig.ts';
import { ACTIONS, CONTEXTS, keyLabel, KEYS_TEMPLATE } from './tui/keys.ts';
import {
  accessLines,
  GROUPS,
  type ReportLine,
  accessSummaryLines,
  usageLines,
} from './tui/reports.ts';
import type { UsageGroup } from '@anchi/protocol';

/** Prints report lines, coloured on a terminal. */
function printReport(lines: ReportLine[]) {
  const colors = new Set(['red', 'yellow', 'green', 'gray']);
  for (const l of lines) {
    let text = l.text;
    if (process.stdout.isTTY) {
      if (l.bold) text = styleText('bold', text);
      if (l.dim) text = styleText('dim', text);
      if (l.color && colors.has(l.color)) text = styleText(l.color as 'red', text);
    }
    console.log(text);
  }
}

const layout = homeLayout();
const keysFile = join(layout.root, 'keybindings.json');

function fail(message: string): never {
  console.error(styleText('red', sanitizeLine(message)));
  process.exit(1);
}

async function withClient<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T> {
  const client = await connectOrStart(layout);
  try {
    return await fn(client);
  } catch (err) {
    fail((err as Error).message);
  } finally {
    client.close();
  }
}

/** Reads a line from the terminal without echoing it. */
function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    process.stdout.write(prompt);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes('\n')) write.call(rl, '\n');
    };
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function taskLine(t: TaskRow): string {
  const color = {
    queued: 'blue',
    running: 'yellow',
    done: 'green',
    failed: 'red',
    cancelled: 'gray',
  } as const;
  return `${styleText(color[t.status], t.status.padEnd(10))}${t.id}  @${t.agentId.padEnd(12)} ${sanitizeLine(t.title).slice(0, 60)}${
    t.links.length ? `  ${t.links.map(sanitizeLine).join(' ')}` : ''
  }`;
}

/** Streams a task's events until its current turn ends. */
async function follow(client: DaemonClient, task: TaskRow, verbose: boolean): Promise<TaskRow> {
  const renderer = new TerminalRenderer(process.stdout, verbose);
  let last = 0;
  const off = client.on('event', ({ taskId, seq, event }) => {
    if (taskId !== task.id || seq === undefined || seq <= last) return;
    last = seq;
    renderer.render(event);
  });
  for (const e of await client.call('tasks.events', { taskId: task.id })) {
    if (e.seq > last) {
      last = e.seq;
      renderer.render(e.event);
    }
  }
  const done = await client.call('tasks.wait', { taskId: task.id });
  off();
  renderer.flush();
  return done;
}

const program = new Command('anchi').description('Anchi (安栖): a secured agent team');
const versionFile = existsSync(join(REPO_ROOT, 'manifest.json'))
  ? join(REPO_ROOT, 'manifest.json')
  : join(REPO_ROOT, 'anchi/package.json');
const appVersion = (JSON.parse(readFileSync(versionFile, 'utf8')) as { version: string }).version;
program.version(appVersion);

program
  .command('update')
  .description('Update this installation to the latest release')
  .option('--check', 'Check for a newer version without installing')
  .action(async (options: { check?: boolean }) => {
    await selfUpdate(REPO_ROOT, appVersion, options.check).catch((e: Error) => fail(e.message));
  });

program
  .command('tui', { isDefault: true })
  .description('Open the full-screen client (starts the daemon if needed)')
  .action(async () => {
    const client = await connectOrStart(layout).catch((e: Error) => fail(e.message));
    await runTui(client, keysFile);
  });

const keysCmd = program
  .command('keys')
  .description(`Key bindings of the TUI: the defaults merged with ${keysFile}`)
  .action(() => {
    const { keymap, warnings } = loadKeyMap(keysFile);
    console.log(`${keysFile}${existsSync(keysFile) ? '' : ' (absent: defaults)'}`);
    console.log(`leader ${keyLabel(keymap.leader)}`);
    for (const ctx of CONTEXTS) {
      console.log(`\n${ctx}`);
      for (const [keys, action] of keymap.contexts[ctx]) {
        console.log(`  ${keyLabel(keys).padEnd(14)} ${action.padEnd(24)} ${ACTIONS[action].title}`);
      }
    }
    for (const w of warnings) console.log(styleText('yellow', `\nskipped: ${w}`));
    if (warnings.length) process.exitCode = 1;
  });
keysCmd
  .command('init')
  .description('Write a starting keybindings.json (the leader and an example)')
  .action(() => {
    if (existsSync(keysFile)) fail(`${keysFile} exists; edit it, or remove it to start again`);
    mkdirSync(dirname(keysFile), { recursive: true });
    writeFileSync(keysFile, KEYS_TEMPLATE, { flag: 'wx' });
    console.log(`wrote ${keysFile}; the TUI picks up changes while it runs`);
  });

program
  .command('run <agent> <text...>')
  .description('Give an agent a task and stream it until the turn ends')
  .option('-v, --verbose', 'show tool output')
  .action((agentId: string, words: string[], opts: { verbose?: boolean }) =>
    withClient(async (client) => {
      const task = await client.call('tasks.create', { agentId, text: words.join(' ') });
      const done = await follow(client, task, Boolean(opts.verbose));
      console.log(taskLine(done));
      if (done.status !== 'done') process.exitCode = 1;
    }),
  );

program
  .command('send <task> <text...>')
  .description('Send a follow-up to a task')
  .option('-v, --verbose', 'show tool output')
  .action((taskId: string, words: string[], opts: { verbose?: boolean }) =>
    withClient(async (client) => {
      const task = await client.call('tasks.send', { taskId, text: words.join(' ') });
      const done = await follow(client, task, Boolean(opts.verbose));
      console.log(taskLine(done));
      if (done.status !== 'done') process.exitCode = 1;
    }),
  );

program
  .command('retry <task>')
  .description('Run a failed or cancelled task again: continue its session, or start over')
  .option('--fresh', 'start over: a new task with the same request')
  .option('-v, --verbose', 'show tool output')
  .action((taskId: string, opts: { fresh?: boolean; verbose?: boolean }) =>
    withClient(async (client) => {
      const task = await client.call('tasks.retry', { taskId, fresh: opts.fresh === true });
      if (task.id !== taskId) console.log(`started again as ${task.id}`);
      const done = await follow(client, task, Boolean(opts.verbose));
      console.log(taskLine(done));
      if (done.status !== 'done') process.exitCode = 1;
    }),
  );

program
  .command('audit <task>')
  .description(
    "A task's external access: hosts requested, credentials injected, refusals (egress audit log)",
  )
  .option('--json', 'the full report as JSON')
  .action((taskId: string, opts: { json?: boolean }) =>
    withClient(async (client) => {
      const a = await client.call('tasks.audit', { taskId });
      if (opts.json) return console.log(JSON.stringify(a, null, 2));
      printReport(accessLines(a, process.stdout.columns || 120));
    }),
  );

program
  .command('access')
  .description('External access of every agent over a period: hosts, injections, refusals')
  .option('--since <age>', 'period, e.g. 24h or 7d', '7d')
  .option('--json', 'the summary as JSON')
  .action((opts: { since: string; json?: boolean }) =>
    withClient(async (client) => {
      const age = /^(\d+)([hd])$/.exec(opts.since);
      if (!age) fail('--since takes a number of hours or days, such as 24h or 7d');
      const ms = Number(age![1]) * (age![2] === 'h' ? 3_600_000 : 86_400_000);
      const summary = await client.call('access.summary', { since: Date.now() - ms });
      if (opts.json) return console.log(JSON.stringify(summary, null, 2));
      const lines = accessSummaryLines(summary, 0, process.stdout.columns || 120);
      printReport(
        lines.map((l, i) => (i === 0 ? { ...l, text: `External access, last ${opts.since}` } : l)),
      );
    }),
  );

program
  .command('usage')
  .description('Token use by agent, model, runtime or day, and the subscription limits last seen')
  .option('--since <age>', 'period, e.g. 24h or 7d', '7d')
  .option('--by <group>', 'agent, model, runtime or day', 'agent')
  .option('--json', 'totals and limits as JSON')
  .action((opts: { since: string; by: string; json?: boolean }) =>
    withClient(async (client) => {
      const age = /^(\d+)([hd])$/.exec(opts.since);
      if (!age) fail('--since takes a number of hours or days, such as 24h or 7d');
      if (!GROUPS.includes(opts.by as UsageGroup)) fail('--by takes agent, model, runtime or day');
      const ms = Number(age![1]) * (age![2] === 'h' ? 3_600_000 : 86_400_000);
      const by = opts.by as UsageGroup;
      const [rows, quota] = await Promise.all([
        client.call('usage.summary', { since: Date.now() - ms, by }),
        client.call('usage.quota').catch(() => []),
      ]);
      if (opts.json)
        return console.log(JSON.stringify({ since: opts.since, by, rows, quota }, null, 2));
      const lines = usageLines(rows, quota, 0, by, process.stdout.columns || 120);
      // The period label of the screen does not fit a free --since: name it as asked.
      printReport(
        lines.map((l) =>
          l.text.startsWith('Tokens, ')
            ? { ...l, text: `Tokens, last ${opts.since}, by ${by}` }
            : l,
        ),
      );
    }),
  );

program
  .command('tasks')
  .description('List tasks, newest first')
  .option('-a, --agent <id>')
  .option('-s, --status <status>', 'queued, running, done, failed or cancelled')
  .option('-q, --search <words>', 'words in the title or result')
  .option('--since <age>', 'created within, e.g. 24h or 7d')
  .option('-n, --limit <n>', 'how many', '50')
  .action(
    (opts: { agent?: string; status?: string; search?: string; since?: string; limit: string }) =>
      withClient(async (client) => {
        const age = opts.since ? /^(\d+)([hd])$/.exec(opts.since) : null;
        if (opts.since && !age) fail('--since takes a number of hours or days, such as 24h or 7d');
        const since = age
          ? Date.now() - Number(age[1]) * (age[2] === 'h' ? 3600_000 : 86_400_000)
          : undefined;
        const list = await client.call('tasks.search', {
          agentId: opts.agent,
          status: opts.status as TaskRow['status'] | undefined,
          text: opts.search,
          since,
          limit: Number(opts.limit) || 50,
        });
        for (const t of list) console.log(taskLine(t));
      }),
  );

program
  .command('rm <task>')
  .description('Delete a finished task, the tasks it delegated and their transcripts')
  .action((taskId: string) =>
    withClient(async (client) => {
      const { deleted } = await client.call('tasks.delete', { taskId });
      console.log(`deleted ${deleted} task(s)`);
    }),
  );

program
  .command('scan <task>')
  .description("Credential-invariant scan of a task's live cell")
  .action(async (taskId: string) => {
    await withClient(async (client) => {
      const r = await client.call('tasks.scan', { taskId });
      console.log(
        r.clean
          ? styleText(
              'green',
              `clean: no real credential in ${r.files} files or the cell's processes`,
            )
          : styleText('red', `FOUND: ${JSON.stringify(r.findings)}`),
      );
      if (!r.clean) process.exitCode = 1;
    });
  });

const skillsCmd = program.command('skills').description('Skills agents can use');
skillsCmd.action(() =>
  withClient(async (client) => {
    const list = await client.call('skills.list');
    if (!list.length)
      return console.log('no skills; add one with `anchi skills add <dir or GitHub URL>`');
    for (const s of list) {
      console.log(
        `${s.id.padEnd(20)} ${sanitizeLine(s.description).slice(0, 60)}  ${s.commit ? `${sanitizeLine(s.source)} @ ${s.commit.slice(0, 10)}` : 'local'}`,
      );
    }
  }),
);
skillsCmd
  .command('add <source>')
  .description('From a local directory with SKILL.md, or a GitHub tree URL (pinned to its commit)')
  .option('--id <id>')
  .action((source: string, opts: { id?: string }) =>
    withClient(async (client) => {
      const s = await client.call('skills.add', { source, id: opts.id });
      console.log(`added ${s.id}${s.commit ? ` at ${s.commit.slice(0, 10)}` : ''}`);
    }),
  );
skillsCmd
  .command('update [id]')
  .description('Update GitHub skills to the latest commit of their URL, after showing what changes')
  .option('-y, --yes', 'update without asking')
  .action((id: string | undefined, opts: { yes?: boolean }) =>
    withClient(async (client) => {
      const ids = id
        ? [id]
        : (await client.call('skills.list')).filter((s) => s.commit).map((s) => s.id);
      if (!ids.length) return console.log('no skill was added from a URL');
      for (const sid of ids) {
        const u = await client.call('skills.checkUpdate', { id: sid });
        if (u.upToDate) {
          console.log(`${sid}: up to date (${u.latest.slice(0, 10)})`);
          continue;
        }
        console.log(
          `${sid}: ${u.current?.slice(0, 10) ?? '?'} → ${u.latest.slice(0, 10)}  ${sanitizeLine(u.url)}`,
        );
        for (const [label, files] of [
          ['added', u.added],
          ['changed', u.changed],
          ['removed', u.removed],
        ] as const) {
          if (files.length) console.log(`  ${label}: ${files.map(sanitizeLine).join(', ')}`);
        }
        if (!opts.yes && (await ask(`update ${sid}? [y/N] `)).trim().toLowerCase() !== 'y')
          continue;
        await client.call('skills.update', { id: sid, commit: u.latest });
        console.log(`  updated to ${u.latest.slice(0, 10)}`);
      }
    }),
  );
skillsCmd.command('rm <id>').action((id: string) =>
  withClient(async (client) => {
    await client.call('skills.remove', { id });
    console.log('removed');
  }),
);

program
  .command('triggers')
  .description("Agents' schedules and polls, with their next run and last result")
  .action(() =>
    withClient(async (client) => {
      const list = await client.call('triggers.list');
      if (!list.length) return console.log('no triggers; add `triggers:` to an agent');
      const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '-');
      for (const t of list) {
        console.log(
          `@${t.agentId.padEnd(12)} ${t.kind.padEnd(9)} ${sanitizeLine(t.spec).padEnd(24)} next ${when(t.nextRun)}  last ${when(t.lastRun)}  ${sanitizeLine(t.lastResult ?? '')}`,
        );
      }
    }),
  );

program
  .command('approvals')
  .description('Writes waiting for your approval')
  .action(() =>
    withClient(async (client) => {
      const list = await client.call('approvals.list');
      if (!list.length) return console.log('no writes waiting for approval');
      for (const a of list) {
        console.log(
          `${a.id}  @${sanitizeLine(a.agent)} ${sanitizeLine(a.task)}  ${sanitizeLine(a.connector)}: ${sanitizeLine(a.operation)}`,
        );
        if (a.reason) console.log(`    why: ${sanitizeLine(a.reason)}`);
        if (a.origin) console.log(`    started by: ${sanitizeLine(a.origin)}`);
        for (const line of sanitizeLine(a.summary).slice(0, 300).split('\n'))
          console.log(`    ${line}`);
      }
    }),
  );

for (const [name, allow] of [
  ['approve', true],
  ['deny', false],
] as const) {
  program
    .command(`${name} <id>`)
    .description(`${allow ? 'Approve' : 'Deny'} a write waiting for approval`)
    .action((id: string) =>
      withClient(async (client) => {
        await client.call('approvals.decide', { id, allow });
        console.log(allow ? 'approved' : 'denied');
      }),
    );
}

program.command('cancel <task>').action(async (taskId: string) => {
  await withClient((client) => client.call('tasks.cancel', { taskId }));
});

const agentsCmd = program.command('agents').description('List agents');
agentsCmd
  .command('rm <id>')
  .description('Delete an agent with its tasks and its files in the VM (workspaces are kept)')
  .option('-y, --yes', 'delete without typing the id')
  .action((id: string, opts: { yes?: boolean }) => deleteAgentCli(id, opts.yes === true));
agentsCmd
  .command('allow-host <id> <host>')
  .description("Add one host to an agent's egress list (a host its cells were refused)")
  .action((id: string, host: string) =>
    withClient(async (client) => {
      const r = await client.call('agents.allowHost', { agentId: id, host });
      console.log(`@${id} may now reach: ${r.egress.join(', ')} (from its next cell)`);
    }),
  );
agentsCmd.action(() =>
  withClient(async (client) => {
    for (const a of await client.call('agents.list')) {
      const extra = a.error
        ? styleText('red', ` ${sanitizeLine(a.error)}`)
        : ` ${a.connectors.join(',') || '-'} · ${a.image}`;
      console.log(`${a.id.padEnd(14)} ${a.status.padEnd(8)}${extra}`);
    }
  }),
);

async function deleteAgentCli(id: string, yes: boolean) {
  await withClient(async (client) => {
    const p = await client.call('agents.deletePreview', { agentId: id });
    console.log(`Deleting @${p.agentId} deletes, and nothing can bring back:`);
    console.log(`  ${p.exists ? 'its agent file' : 'its agent file: already gone'}`);
    console.log(
      `  ${p.tasks} task(s) and their transcripts, with ${p.delegated} task(s) other agents did for them`,
    );
    if (p.running)
      console.log(styleText('yellow', `  ${p.running} running or queued: cancelled first`));
    if (p.triggers) console.log(`  ${p.triggers} trigger(s)`);
    console.log(
      '  in the VM: its home (work directory, sessions), its skills and its policy rules',
    );
    if (p.delegatedBy.length)
      console.log(
        `It is removed from the delegates of ${p.delegatedBy.map((a) => `@${a}`).join(', ')}.`,
      );
    console.log(
      styleText(
        'green',
        `Kept: ${p.workspaces.map((w) => `~/AnchiWorkspaces/${w}`).join(', ') || 'directories of your computer'} and the audit logs.`,
      ),
    );
    if (!yes && (await ask(`Type ${p.agentId} to confirm: `)).trim() !== p.agentId) {
      return console.log('not deleted');
    }
    const r = await client.call('agents.delete', { agentId: p.agentId, confirm: p.agentId });
    console.log(
      `deleted @${r.agentId}: ${r.deletedTasks} task(s)${r.editedAgents.length ? `; delegates edited in ${r.editedAgents.join(', ')}` : ''}`,
    );
    for (const w of r.warnings) console.log(styleText('yellow', w));
    if (r.warnings.length) process.exitCode = 1;
  });
}

const setup = program.command('setup').description('Runtime and connector setup');

setup.command('status').action(() =>
  withClient(async (client) => {
    console.log(JSON.stringify(await client.call('setup.status'), null, 2));
  }),
);

setup
  .command('codex')
  .description('Import the Codex login from ~/.codex/auth.json into the VM vault')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((opts: { yes?: boolean }) =>
    withClient(async (client) => {
      if (!opts.yes) {
        const answer = await ask(
          'Read the access token and account id from ~/.codex/auth.json and store them in the VM vault? [y/N] ',
        );
        if (answer.toLowerCase() !== 'y') fail('cancelled');
      }
      const s = await client.call('setup.importCodex');
      console.log(
        `Codex connected; token valid until ${new Date(s.expiresAt ?? 0).toLocaleString()}`,
      );
    }),
  );

/** Runs a setup step in the daemon and prints its output as it arrives. */
function runSetup(action: SetupAction, yes: boolean, consent: string) {
  return withClient(async (client) => {
    if (!yes && (await ask(`${consent} [y/N] `)).toLowerCase() !== 'y') fail('cancelled');
    const off = client.on('setup', (n) => {
      if (n.action === action) console.log(sanitizeLine(n.line));
    });
    const s = await client.call('setup.run', { action });
    off();
    console.log(
      `VM ${s.vm} · vault ${s.vaultUnlocked ? 'unlocked' : 'locked'} · base image ${s.installed ? 'built' : 'not built'}`,
    );
  });
}

setup
  .command('claude')
  .description('Store a `claude setup-token` token or an Anthropic API key in the VM vault')
  .action(() =>
    withClient(async (client) => {
      const token = process.stdin.isTTY
        ? await askSecret('Claude Code token (from `claude setup-token`) or API key: ')
        : await readStdin();
      const s = await client.call('setup.importClaude', { token });
      console.log(
        `Claude Code connected (${s.kind === 'api_key' ? 'API key' : 'subscription token'})`,
      );
    }),
  );

setup
  .command('workspaces')
  .description('Share ~/AnchiWorkspaces with the VM (macOS and Linux; restarts the VM once)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((opts: { yes?: boolean }) =>
    runSetup(
      'workspaces',
      Boolean(opts.yes),
      'Mount ~/AnchiWorkspaces into the VM? The VM restarts: running tasks stop, and the vault is unlocked again afterwards.',
    ),
  );

setup
  .command('vm')
  .description('Start the VM')
  .action(() => runSetup('vm-start', true, ''));

setup
  .command('install')
  .description('Create or update the VM, install the services and build the base image')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((opts: { yes?: boolean }) =>
    runSetup(
      'install',
      Boolean(opts.yes),
      'Create or update the anchi-vm VM, install the trusted services and the agent team, and build the base image (several minutes)?',
    ),
  );

setup
  .command('vault <action>')
  .description('init or unlock the VM vault with the key in ~/.config/anchi/vault.key')
  .action((action: string) => {
    if (action !== 'init' && action !== 'unlock') fail('vault action must be init or unlock');
    return runSetup(action === 'init' ? 'vault-init' : 'vault-unlock', true, '');
  });

setup
  .command('connector <id>')
  .description('Connect github, aws or linear (secrets are read without echo)')
  .option('--from-gh', 'github: import the token the gh CLI is logged in with')
  .option('--profile <name>', 'aws: use a host profile (SSO); the daemon keeps it refreshed')
  .option('-y, --yes', 'do not ask for confirmation')
  .action((id: string, opts: { fromGh?: boolean; profile?: string; yes?: boolean }) =>
    withClient(async (client) => {
      if (opts.fromGh) {
        if (id !== 'github') fail('--from-gh applies to github');
        const consent =
          'Read the token of the gh CLI (`gh auth token`) and store it in the VM vault? ' +
          'It carries all the scopes of your gh login; a fine-grained token is narrower.';
        if (!opts.yes && (await ask(`${consent} [y/N] `)).toLowerCase() !== 'y') fail('cancelled');
        const status = await client.call('connectors.importGh');
        return console.log(`github connected (${sanitizeLine(status.account ?? '?')})`);
      }
      if (opts.profile) {
        if (id !== 'aws') fail('--profile applies to aws');
        const status = await client.call('connectors.awsProfile', { profile: opts.profile });
        return console.log(
          `aws connected (${sanitizeLine(status.account ?? '?')}) through profile ${sanitizeLine(opts.profile)}; refreshed before expiry`,
        );
      }
      let secret: ConnectorSecret;
      if (id === 'github' || id === 'linear') {
        // Tokens may also come on stdin for scripts: `anchi setup connector github < token-file`.
        const token = process.stdin.isTTY ? await askSecret(`${id} token: `) : await readStdin();
        secret = { id, token };
      } else if (id === 'aws' && !process.stdin.isTTY) {
        // Scripts: {"accessKeyId", "secretAccessKey", "region", "sessionToken"?} on stdin.
        const v = JSON.parse(await readStdin()) as Record<string, string>;
        secret = {
          id: 'aws',
          accessKeyId: v.accessKeyId ?? '',
          secretAccessKey: v.secretAccessKey ?? '',
          region: v.region ?? '',
          ...(v.sessionToken ? { sessionToken: v.sessionToken } : {}),
        };
      } else if (id === 'aws') {
        secret = {
          id: 'aws',
          accessKeyId: await ask('Access key id (dedicated principal): '),
          secretAccessKey: await askSecret('Secret access key: '),
          region: await ask('Region: '),
        };
        const session = await askSecret('Session token (Enter to skip): ');
        if (session) secret.sessionToken = session;
      } else {
        fail('connector must be github, aws or linear');
      }
      const status = await client.call('connectors.set', secret);
      console.log(
        `${status.id} connected${status.account ? ` (${sanitizeLine(status.account)})` : ''}`,
      );
    }),
  );

const SERVICE_IDS = ['gmail', 'drive', 'notion', 'slack'] as const;
type ServiceId = (typeof SERVICE_IDS)[number];
const isService = (id: string): id is ServiceId => (SERVICE_IDS as readonly string[]).includes(id);

setup
  .command('disconnect <id>')
  .option('--account <name>', 'gmail or drive: the account to disconnect (default: default)')
  .action(async (id: string, opts: { account?: string }) => {
    if (opts.account && id !== 'gmail' && id !== 'drive')
      fail('--account applies to gmail and drive');
    await withClient((client) =>
      isService(id)
        ? client.call('services.disconnect', { id, account: opts.account })
        : client.call('connectors.remove', { id: id as ConnectorId }),
    );
  });

setup
  .command('service <id>')
  .description('Connect gmail or drive (Google sign-in) or notion or slack (token, without echo)')
  .option(
    '--account <name>',
    'gmail or drive: name this Google account (e.g. work) to connect more than one; agents pick it with accounts: { gmail: work }',
  )
  .action((id: string, opts: { account?: string }) =>
    withClient(async (client) => {
      if (!isService(id)) fail('service must be gmail, drive, notion or slack');
      if (id === 'notion' || id === 'slack') {
        if (opts.account) fail('--account applies to gmail and drive');
        const token = process.stdin.isTTY ? await askSecret(`${id} token: `) : await readStdin();
        await client.call('services.setToken', { id, token });
        return console.log(`${id} connected`);
      }
      const account = opts.account ?? 'default';
      const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        client.on(
          'oauth',
          (r) => r.id === id && (r.account ?? 'default') === account && resolve(r),
        );
      });
      const { url } = await client.call('services.googleLogin', { id, account: opts.account });
      console.log(`Sign in to Google in your browser. If it did not open:\n${url}`);
      const r = await done;
      if (!r.ok) fail(r.error ?? 'sign-in failed');
      console.log(`${id} connected${opts.account ? ` (account ${opts.account})` : ''}`);
    }),
  );

setup
  .command('google-client [path]')
  .description(
    'Store your own Google Cloud Desktop app OAuth client JSON (Gmail and Drive); it overrides the built-in client',
  )
  .option('--remove', 'remove your client and use the built-in one, when Anchi ships one')
  .action((path: string | undefined, opts: { remove?: boolean }) =>
    withClient(async (client) => {
      if (opts.remove) {
        if (path) fail('--remove takes no path');
        await client.call('services.removeGoogleClient');
        const s = await client.call('setup.status');
        return console.log(
          s.googleClientSource === 'builtin'
            ? 'Your Google client is removed; the built-in client applies'
            : 'Your Google client is removed; there is no built-in client, so Gmail and Drive need one again',
        );
      }
      if (!path) fail('usage: setup google-client <path> | --remove');
      if (statSync(path).size > 16_384) fail('that file is too large for a client JSON');
      await client.call('services.googleClient', { json: readFileSync(path, 'utf8') });
      console.log('Google client stored');
    }),
  );

/** Deletes the Anchi home for `setup reset --all`, keeping keybindings.json (a preference). */
function deleteHome(root: string) {
  const full = resolvePath(root);
  if (full === '/' || full === resolvePath(homedir()) || !existsSync(full)) return;
  for (const name of readdirSync(full)) {
    if (name !== 'keybindings.json') rmSync(join(full, name), { recursive: true, force: true });
  }
}

setup
  .command('reset')
  .description(
    'Back to a first launch: delete the VM with everything in it (--all: also the vault key and the Anchi home)',
  )
  .option('--all', 'also delete the vault key and ~/.anchi (agents, tasks, settings, logs)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(async (opts: { all?: boolean; yes?: boolean }) => {
    let home = '';
    let vaultKey = '';
    await withClient(async (client) => {
      const p = await client.call('setup.resetPreview');
      if (p.busy) fail(`${p.busy} task(s) running or queued; cancel them or let them finish first`);
      ({ home, vaultKey } = p);
      console.log('Reset deletes, and nothing can bring back:');
      console.log(
        `  the anchi-vm VM (${p.vm}) and everything in it: the vault's credentials (Codex, ` +
          'Claude Code, Google, Notion, Slack, GitHub, AWS, Linear), agent homes, images and the audit log',
      );
      if (p.cells) console.log(`  ${p.cells} idle cell(s): closed first`);
      if (opts.all) {
        console.log(`  the vault key ${vaultKey}`);
        console.log(
          `  ${home}: agents, templates, images, skills, settings, the task database and logs`,
        );
        console.log(styleText('green', `Kept: ${join(home, 'keybindings.json')}.`));
      } else {
        console.log(
          styleText(
            'green',
            `Kept: the vault key and ${home} (agents, tasks, settings). After \`anchi setup install\` ` +
              'and `anchi setup vault init`, the vault is new and empty, with the same key.',
          ),
        );
      }
      if (!opts.yes && (await ask('Type reset to confirm: ')) !== 'reset') fail('not reset');
      const off = client.on('reset', (n) => console.log(sanitizeLine(n.line)));
      await client.call('setup.reset', { confirm: 'reset' });
      off();
      if (opts.all) await client.call('daemon.shutdown');
    });
    if (!opts.all) {
      return console.log('VM deleted. Next: `anchi setup install`, then `anchi setup vault init`.');
    }
    // The daemon holds the database; its home goes only once it has exited.
    for (let i = 0; i < 100; i++) {
      const c = await tryConnect(layout);
      if (!c) break;
      c.close();
      if (i === 99) fail('the daemon did not stop; run `anchi daemon stop` and reset again');
      await new Promise((r) => setTimeout(r, 100));
    }
    rmSync(vaultKey, { force: true });
    deleteHome(home);
    console.log('Reset done. The next `anchi` starts from the first launch.');
  });

setup
  .command('service-mode <id> <mode>')
  .description('Writes of a service: auto, or ask (each write waits for approval)')
  .action((id: string, mode: string) =>
    withClient(async (client) => {
      if (!isService(id) || (mode !== 'auto' && mode !== 'ask'))
        fail('usage: service-mode <gmail|drive|notion|slack> <auto|ask>');
      await client.call('services.setMode', { id, mode });
      console.log(`${id} writes: ${mode}`);
    }),
  );

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) fail('no secret on stdin: run this in a terminal to be prompted, or redirect a file');
  return text;
}

const daemon = program.command('daemon').description('Manage the background daemon');
daemon.command('start').action(async () => {
  (await connectOrStart(layout)).close();
  console.log('daemon running');
});
daemon.command('stop').action(async () => {
  const client = await tryConnect(layout);
  if (!client) return console.log('daemon not running');
  await client.call('daemon.shutdown');
  client.close();
  console.log('daemon stopped');
});
daemon.command('status').action(async () => {
  const client = await tryConnect(layout);
  if (!client) return console.log('daemon not running');
  console.log(JSON.stringify(await client.call('daemon.status'), null, 2));
  client.close();
});
daemon
  .command('install')
  .description('Run the daemon at login (launchd on macOS, a systemd user unit on Linux)')
  .action(() => console.log(`installed ${installAutostart(layout)}`));
daemon
  .command('uninstall')
  .action(() => console.log(uninstallAutostart() ? 'uninstalled' : 'not installed'));

await program.parseAsync();
