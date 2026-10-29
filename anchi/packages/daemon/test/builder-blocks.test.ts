import { expect, it } from 'vitest';
import { parseBlocks } from '../src/builder.ts';

it('ignores incomplete proposals without rescanning each unterminated opener', () => {
  const text = '```anchi-agent id=0\n' + '```anchi-agent id=0\na'.repeat(50_000);
  const started = performance.now();
  expect(parseBlocks(text)).toEqual({});
  expect(performance.now() - started).toBeLessThan(1000);
});

it('keeps the last complete agent or patch and image, ignoring an unfinished replacement', () => {
  expect(
    parseBlocks(
      [
        '```anchi-agent id=dev',
        'runtime: codex',
        '```',
        '```anchi-image id=tools',
        'packages: [jq]',
        '```',
        '```anchi-agent-patch id=dev \t',
        'model: example',
        '```',
        '```anchi-agent id=unfinished',
        'runtime: codex',
      ].join('\n'),
    ),
  ).toEqual({
    patch: { id: 'dev', yaml: 'model: example\n' },
    image: { id: 'tools', yaml: 'packages: [jq]\n' },
  });
});
