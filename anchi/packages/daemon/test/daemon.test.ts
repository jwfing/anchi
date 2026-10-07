import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeLayout } from '@anchi/core';
import type { TaskRow } from '@anchi/protocol';
import {
  Daemon,
  DaemonClient,
  type ExecResult,
  Guest,
  type GuestTransport,
  LimaTransport,
  lineDiff,
  parseBlocks,
} from '../src/index.ts';
import { extractLinks } from '../src/store.ts';

const RUNNER = join(import.meta.dirname, 'fixtures/fake-runner.mjs');

class FakeTransport implements GuestTransport {
  mode = 'ok';
  starts: string[][] = [];
  execs: { args: string[]; stdin: string }[] = [];
  images = new Set(['codex@base']);

  spawn(args: string[]) {
    this.starts.push(args);
    return spawn(process.execPath, [RUNNER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_MODE: this.mode },
    });
  }

  async exec(args: string[], stdin = ''): Promise<ExecResult> {
    this.execs.push({ args, stdin });
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
    if (args[0] === 'anchi-cell' && args[1] === 'reap') return ok({ reaped: ['t-old'] });
    if (args[0] === 'anchi-image' && args[1] === 'status') {
      return ok({ present: this.images.has(`${args[2]}@${args[3]}`) });
    }
    if (args[0] === 'anchi-image' && args[1] === 'build') {
      this.images.add(`${args[2]}@${args[3]}`);
      return ok({ image: args[2], hash: args[3], ok: true, size: 1e6, seconds: 1, log: '/x' });
    }
    return { code: 1, stdout: '{"error":"UNEXPECTED"}', stderr: '' };
  }
}

let root: string;
let transport: FakeTransport;
let daemon: Daemon | undefined;
let client: DaemonClient | undefined;

function write(rel: string, content: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

async function start(idleMs = 60_000) {
  const layout = homeLayout(root);
  const d = new Daemon({
    layout,
    guest: new Guest(transport),
    lima: new LimaTransport(),
    log: () => {},
    quiet: true,
    idleMs,
  });
  await d.start();
  daemon = d;
  const c = await DaemonClient.connect(layout.socketFile);
  client = c;
  return { daemon: d, client: c };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anchi-daemon-'));
  transport = new FakeTransport();
  write('agents/dev.yaml', 'runtime: codex\nconnectors: [github]\n');
});

afterEach(async () => {
  client?.close();
  await daemon?.stop();
  client = undefined;
  daemon = undefined;
});

describe('daemon tasks', () => {
  it('runs a task in a cell and records result, links and events', async () => {
    const { client, daemon } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'fix the bug' });
    expect(task.id).toMatch(/^t-[0-9a-f]{10}$/);
    const done = await client.call('tasks.wait', { taskId: task.id });
    expect(done.status).toBe('done');
    expect(done.result).toMatch(/fix the bug/);
    expect(done.links).toEqual(['https://github.com/o/r/pull/1']);
    expect(done.resumeId).toBe('thread-1');
    expect(transport.starts[0]).toEqual([
      'anchi-cell',
      'start',
      task.id,
      'dev',
      'codex',
      'base',
      'github',
      'cell',
    ]);
    const events = await client.call('tasks.events', { taskId: task.id });
    expect(events.map((e) => e.event.type)).toEqual([
      'input',
      'session.started',
      'tool.call',
      'tool.result',
      'message',
      'turn.completed',
    ]);
  });

  it('reuses the cell for a follow-up and starts a new one after the idle timeout', async () => {
    const { client, daemon } = await start(150);
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'one' });
    const first = await client.call('tasks.wait', { taskId: task.id });
    await client.call('tasks.send', { taskId: task.id, text: 'two' });
    const second = await client.call('tasks.wait', { taskId: task.id });
    const pid = (r: TaskRow) => /pid (\d+)/.exec(r.result!)![1];
    expect(pid(second)).toBe(pid(first));
    expect(second.result).toMatch(/turn 2/);
    await new Promise((r) => setTimeout(r, 400));
    expect(daemon.hub.cellCount()).toBe(0);
    await client.call('tasks.send', { taskId: task.id, text: 'three' });
    const third = await client.call('tasks.wait', { taskId: task.id });
    expect(pid(third)).not.toBe(pid(first));
    // The new cell resumes the persistent runtime session.
    expect(third.result).toMatch(/resume=thread-1/);
    expect(transport.starts).toHaveLength(2);
  });

  it.each(['bad-frame', 'wrong-turn', 'huge', 'fail-start'])(
    'fails the task and ends the cell when the runner misbehaves (%s)',
    async (mode) => {
      transport.mode = mode;
      const { client, daemon } = await start();
      const task = await client.call('tasks.create', { agentId: 'dev', text: 'x' });
      const done = await client.call('tasks.wait', { taskId: task.id });
      expect(done.status).toBe('failed');
      await new Promise((r) => setTimeout(r, 50));
      expect(daemon.hub.cellCount()).toBe(0);
    },
  );

  it('cancels a running task', async () => {
    transport.mode = 'slow';
    const { client, daemon } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'x' });
    await new Promise((r) => setTimeout(r, 300));
    await client.call('tasks.cancel', { taskId: task.id });
    const done = await client.call('tasks.wait', { taskId: task.id });
    expect(done.status).toBe('cancelled');
  });

  it('builds a missing recipe image before starting the cell', async () => {
    write('images/node.yaml', 'packages: [nodejs]\n');
    write('agents/dev.yaml', 'runtime: codex\nimage: node\n');
    const { client, daemon } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'x' });
    await client.call('tasks.wait', { taskId: task.id });
    const build = transport.execs.find((e) => e.args[1] === 'build')!;
    expect(build.args[2]).toBe('node');
    expect(JSON.parse(build.stdin)).toEqual({ packages: ['nodejs'], run: [] });
    expect(transport.starts[0]![4]).toBe('node');
  });

  it('reaps orphaned cells and fails interrupted tasks on start', async () => {
    const first = await start();
    const task = await first.client.call('tasks.create', { agentId: 'dev', text: 'x' });
    await first.client.call('tasks.wait', { taskId: task.id });
    first.client.close();
    await first.daemon.stop();
    // Simulate a crash mid-turn.
    const { Store } = await import('../src/store.ts');
    const store = new Store(homeLayout(root).dbFile);
    store.setStatus(task.id, 'running');
    store.close();
    const second = await start();
    expect(transport.execs.some((e) => e.args[1] === 'reap')).toBe(true);
    expect((await second.client.call('tasks.get', { taskId: task.id })).status).toBe('failed');
  });

  it('rejects invalid ids and unknown agents', async () => {
    const { client, daemon } = await start();
    await expect(client.call('tasks.get', { taskId: '../x' })).rejects.toThrow(/invalid task id/);
    await expect(client.call('tasks.create', { agentId: 'nope', text: 'x' })).rejects.toThrow(
      /unknown agent/,
    );
  });

  it('accepts a task for an agent file written just before it', async () => {
    const { client } = await start();
    write('agents/fresh.yaml', 'runtime: codex\n');
    const task = await client.call('tasks.create', { agentId: 'fresh', text: 'hello' });
    expect((await client.call('tasks.wait', { taskId: task.id })).status).toBe('done');
  });
});

describe('builder', () => {
  const reply = [
    'Here is the agent.',
    '```anchi-agent id=devops',
    'name: DevOps',
    'runtime: codex',
    'connectors: [aws, github]',
    'image: awscli',
    'prompt:',
    '  text: Read CloudWatch logs and file issues.',
    '```',
    '```anchi-image id=awscli',
    'packages: [unzip]',
    'run: ["echo install aws"]',
    '```',
  ].join('\n');

  it('parses proposal blocks', () => {
    const blocks = parseBlocks(reply);
    expect(blocks.agent?.id).toBe('devops');
    expect(blocks.image?.yaml).toMatch(/unzip/);
  });

  it('turns builder output into a proposal that only apply writes', async () => {
    const { client, daemon } = await start();
    const agents = await client.call('agents.list');
    expect(agents.map((a) => a.id)).toContain('builder');
    const proposal = daemon.proposals.add(parseBlocks(reply))!;
    expect(proposal.errors).toEqual([]);
    expect(proposal.agentDiff).toMatch(/^\+ name: DevOps/m);
    expect(() => readFileSync(join(root, 'agents/devops.yaml'))).toThrow();
    const after = await client.call('builder.apply', { proposalId: proposal.id });
    expect(after.find((a) => a.id === 'devops')?.connectors).toEqual(['aws', 'github']);
    expect(readFileSync(join(root, 'images/awscli.yaml'), 'utf8')).toMatch(/unzip/);
    await expect(client.call('builder.apply', { proposalId: proposal.id })).rejects.toThrow(
      /unknown proposal/,
    );
  });

  it('flags invalid proposals and never writes them', async () => {
    const { client, daemon } = await start();
    for (const bad of [
      '```anchi-agent id=builder\nruntime: codex\n```',
      '```anchi-agent id=x\nruntime: codex\nconnectors: [gmail]\n```',
      '```anchi-agent id=x\nruntime: codex\nimage: missing\n```',
      '```anchi-agent id=x\nruntime: codex\nextends: base\n```',
      '```anchi-agent id=x\nruntime: codex\nprompt: { file: /etc/passwd }\n```',
    ]) {
      const proposal = daemon.proposals.add(parseBlocks(bad))!;
      expect(proposal.errors.length, bad).toBeGreaterThan(0);
      await expect(client.call('builder.apply', { proposalId: proposal.id })).rejects.toThrow(
        /invalid/,
      );
    }
  });

  it('runs the builder as a built-in agent and broadcasts its proposal', async () => {
    const { client, daemon } = await start();
    const seen: string[] = [];
    client.on('proposal', ({ proposal }) => seen.push(proposal.agentId));
    // The fake runner echoes the input, so the reply carries the blocks.
    const task = await client.call('tasks.create', { agentId: 'builder', text: reply });
    await client.call('tasks.wait', { taskId: task.id });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['devops']);
    expect(transport.starts[0]![6]).toBe('-');
  });
});

describe('helpers', () => {
  it('diffs lines', () => {
    expect(lineDiff('a\nb\n', 'a\nc\n')).toBe('  a\n- b\n+ c');
    expect(lineDiff('', 'x\n')).toBe('+ x');
  });

  it('extracts links without trailing punctuation', () => {
    expect(extractLinks('PR: https://github.com/o/r/pull/2. Issue (https://x.dev/i/1)')).toEqual([
      'https://github.com/o/r/pull/2',
      'https://x.dev/i/1',
    ]);
  });
});
