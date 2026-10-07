import { describe, expect, it } from 'vitest';
import {
  cellCommandSchema,
  cellMessageSchema,
  encodeFrame,
  FrameDecoder,
  type ProtocolError,
  truncate,
} from '../src/index.ts';

function decoder(max = 64) {
  const frames: unknown[] = [];
  const errors: ProtocolError[] = [];
  const d = new FrameDecoder(
    max,
    (f) => frames.push(f),
    (e) => errors.push(e),
  );
  return { d, frames, errors };
}

describe('FrameDecoder', () => {
  it('splits frames across chunks and skips blank lines', () => {
    const { d, frames, errors } = decoder();
    d.push('{"a":');
    d.push(Buffer.from('1}\n\n{"b":"é"}\n{"c"'));
    d.push(':3}\n');
    expect(frames).toEqual([{ a: 1 }, { b: 'é' }, { c: 3 }]);
    expect(errors).toEqual([]);
  });

  it('fails on an oversized frame, with or without a newline, and stops', () => {
    const a = decoder(8);
    a.d.push('{"long":"xxxxxxxx"}\n{"a":1}\n');
    expect(a.errors).toHaveLength(1);
    expect(a.frames).toEqual([]);
    const b = decoder(8);
    b.d.push('{"lo');
    b.d.push('ng":');
    b.d.push('"xx');
    expect(b.errors).toHaveLength(1);
    b.d.push('"}\n{"a":1}\n');
    expect(b.frames).toEqual([]);
  });

  it('fails on invalid JSON instead of skipping it', () => {
    const { d, frames, errors } = decoder();
    d.push('not json\n{"a":1}\n');
    expect(errors[0]?.message).toMatch(/not valid JSON/);
    expect(frames).toEqual([]);
  });

  it('counts bytes, not characters', () => {
    const { d, errors } = decoder(10);
    d.push(`${JSON.stringify('中文中文')}\n`);
    expect(errors).toHaveLength(1);
  });

  it('round-trips encodeFrame', () => {
    const { d, frames } = decoder(1000);
    d.push(encodeFrame({ text: 'line\nbreak' }));
    expect(frames).toEqual([{ text: 'line\nbreak' }]);
  });
});

describe('cell protocol', () => {
  it('accepts valid runner messages and rejects unknown or oversized fields', () => {
    const ok = cellMessageSchema.safeParse({
      type: 'event',
      turn: 't1',
      event: { type: 'message', text: 'hi' },
    });
    expect(ok.success).toBe(true);
    expect(
      cellMessageSchema.safeParse({
        type: 'event',
        turn: 't1',
        event: { type: 'message', text: 'hi', extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      cellMessageSchema.safeParse({
        type: 'event',
        turn: 't1',
        event: { type: 'message', text: 'x'.repeat(70_000) },
      }).success,
    ).toBe(false);
    expect(
      cellMessageSchema.safeParse({
        type: 'event',
        turn: '../x',
        event: { type: 'turn.completed' },
      }).success,
    ).toBe(false);
    expect(cellMessageSchema.safeParse({ type: 'exec', command: 'sh' }).success).toBe(false);
  });

  it('applies turn option defaults and requires an absolute workdir', () => {
    const cmd = cellCommandSchema.parse({
      type: 'run',
      turn: 't1',
      input: 'hi',
      options: { workdir: '/home/agent/work' },
    });
    expect(cmd.type === 'run' && cmd.options).toMatchObject({
      sandbox: 'cell',
      instructionsMode: 'append',
    });
    expect(
      cellCommandSchema.safeParse({
        type: 'run',
        turn: 't1',
        input: 'hi',
        options: { workdir: 'w' },
      }).success,
    ).toBe(false);
  });

  it('truncates with a marker inside the limit', () => {
    const t = truncate('a'.repeat(1000), 100);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t).toMatch(/truncated/);
    expect(truncate('short', 100)).toBe('short');
  });
});
