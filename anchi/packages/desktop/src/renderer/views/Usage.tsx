import { sanitizeLine } from '@anchi/core/sanitize';
import type { QuotaInfo, UsageGroup, UsageRow } from '@anchi/protocol';
import { useEffect, useState } from 'react';
import { useApp } from '../App.tsx';
import { ago, tokens } from '../format.ts';

const PERIODS = [
  { label: '24 h', ms: 86_400_000 },
  { label: '7 days', ms: 7 * 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
];
const GROUPS: UsageGroup[] = ['agent', 'model', 'runtime', 'day'];

/** Yellow from 80 %, red from 95 %, as the TUI marks them. */
function tone(used: number) {
  return used >= 95 ? 'bad' : used >= 80 ? 'warn' : 'ok';
}

export function UsageView() {
  const { act, server, call } = useApp();
  const [period, setPeriod] = useState(1);
  const [group, setGroup] = useState<UsageGroup>('agent');
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [quota, setQuota] = useState<QuotaInfo[]>([]);

  useEffect(() => {
    if (server.status !== 'connected') return;
    const since = Date.now() - PERIODS[period]!.ms;
    void act(() => call('usage.summary', { since, by: group })).then((r) => r && setRows(r));
    void act(() => call('usage.quota')).then((q) => q && setQuota(q));
  }, [period, group, server.status, act]);

  const total = rows.reduce(
    (t, r) => ({
      turns: t.turns + r.turns,
      input: t.input + r.inputTokens,
      cached: t.cached + r.cachedInputTokens,
      output: t.output + r.outputTokens,
      reasoning: t.reasoning + r.reasoningTokens,
      cost: t.cost + r.costUsd,
    }),
    { turns: 0, input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 },
  );
  const showCost = rows.some((r) => r.costUsd > 0);

  return (
    <main className="main page scroll">
      <h1>Usage</h1>
      <section className="card">
        <h2>Subscription limits</h2>
        {!quota.length && <p className="small muted">No runtime is connected yet.</p>}
        {quota.map((q) => (
          <div key={q.runtime} className="quota">
            <div className="row between">
              <span className="strong">
                {q.runtime}
                {q.plan ? ` · ${sanitizeLine(q.plan)}` : ''}
              </span>
              <span className="small muted">
                {q.ts ? `seen ${ago(q.ts)}` : 'no data yet'}
                {q.limited ? ' · limit reached' : ''}
              </span>
            </div>
            {(q.windows ?? []).map((w) => {
              const used = Math.round(w.usedPercent ?? 0);
              const label =
                w.name === 'primary' ? '5-hour' : w.name === 'secondary' ? 'weekly' : w.name;
              return (
                <div key={w.name} className="meter-row">
                  <span className="small">{label}</span>
                  <div
                    className="meter"
                    role="meter"
                    aria-valuenow={used}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${q.runtime} ${label}`}
                  >
                    <div
                      className={`meter-fill meter-${tone(used)}`}
                      style={{ width: `${Math.min(100, used)}%` }}
                    />
                  </div>
                  <span className={`small strong tone-${tone(used)}`}>{used}%</span>
                  <span className="small muted">
                    {w.resetAt ? `resets ${new Date(w.resetAt).toLocaleString()}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </section>
      <section className="card">
        <div className="row gap wrap">
          <h2 className="grow">Tokens</h2>
          <div className="segmented" role="group" aria-label="Period">
            {PERIODS.map((p, i) => (
              <button
                type="button"
                key={p.label}
                aria-pressed={i === period}
                onClick={() => setPeriod(i)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Group by">
            {GROUPS.map((g) => (
              <button type="button" key={g} aria-pressed={g === group} onClick={() => setGroup(g)}>
                {g}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{group}</th>
                <th scope="col">Turns</th>
                <th scope="col">Input</th>
                <th scope="col">Cached</th>
                <th scope="col">Output</th>
                <th scope="col">Reasoning</th>
                {showCost && <th scope="col">Est. cost</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{sanitizeLine(r.key)}</td>
                  <td>{r.turns}</td>
                  <td>{tokens(r.inputTokens)}</td>
                  <td>{tokens(r.cachedInputTokens)}</td>
                  <td>{tokens(r.outputTokens)}</td>
                  <td>{tokens(r.reasoningTokens)}</td>
                  {showCost && <td>${r.costUsd.toFixed(2)}</td>}
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <td>{total.turns}</td>
                <td>{tokens(total.input)}</td>
                <td>{tokens(total.cached)}</td>
                <td>{tokens(total.output)}</td>
                <td>{tokens(total.reasoning)}</td>
                {showCost && <td>${total.cost.toFixed(2)}</td>}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
