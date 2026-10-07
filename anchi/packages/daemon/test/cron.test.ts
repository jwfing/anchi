import { describe, expect, it } from 'vitest';
import { nextRun, parseCron } from '../src/cron.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe('cron', () => {
  it('finds the next matching minute', () => {
    expect(nextRun(parseCron('0 9 * * 1-5'), at(2026, 10, 9, 10))).toBe(at(2026, 10, 12, 9)); // Fri → Mon
    expect(nextRun(parseCron('*/15 * * * *'), at(2026, 10, 7, 8, 7))).toBe(at(2026, 10, 7, 8, 15));
    expect(nextRun(parseCron('30 2 1 * *'), at(2026, 10, 7))).toBe(at(2026, 11, 1, 2, 30));
    expect(nextRun(parseCron('0 0 29 2 *'), at(2026, 3, 1))).toBe(at(2028, 2, 29));
    // Day of month or day of week when both are set; 7 is Sunday.
    expect(nextRun(parseCron('0 12 1 * 7'), at(2026, 10, 7))).toBe(at(2026, 10, 11, 12));
  });

  it('rejects malformed expressions', () => {
    for (const bad of [
      '* * * *',
      '60 * * * *',
      '* * 0 * *',
      'a b c d e',
      '5-1 * * * *',
      '*/0 * * * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });
});
