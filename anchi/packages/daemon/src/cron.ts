/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week), local time.
 * Fields take `*`, numbers, ranges `a-b`, lists `a,b` and steps `* /n` or `a-b/n`. Day of week
 * is 0–7 with 0 and 7 for Sunday. As in Vixie cron, when both day fields are restricted a day
 * matching either one matches.
 */

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

function field(text: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid cron field "${text}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === '*' ? min : Number(m[2]);
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) {
      throw new Error(`cron field "${text}" is out of range ${min}-${max}`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('a cron expression has five fields');
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, RANGES[i]!));
  if (weekday!.has(7)) weekday!.add(0);
  return {
    minute: minute!,
    hour: hour!,
    day: day!,
    month: month!,
    weekday: weekday!,
    dayRestricted: parts[2] !== '*',
    weekdayRestricted: parts[4] !== '*',
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.day.has(d.getDate());
  const dow = c.weekday.has(d.getDay());
  if (c.dayRestricted && c.weekdayRestricted) return dom || dow;
  return dom && dow;
}

/** The first matching minute strictly after `after` (ms), or null within about four years. */
export function nextRun(c: Cron, after: number): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 4 * 366 * 24 * 3600_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}
