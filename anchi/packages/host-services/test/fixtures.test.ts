import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { awsResign, decide, denyResponse, highRisk, isWrite } from '../src/index.ts';
import type { Headers } from '../src/rules/decide.ts';

/**
 * The Python rules (services/egress_rules.py) are the VM's source of truth;
 * scripts/gen-egress-fixtures.py replays them over a corpus and `make check` keeps the file
 * current, so a rule that changes on one side without the other fails here.
 */
interface DecisionCase {
  method: string;
  host: string;
  path: string;
  headers: Headers;
  body: string;
  grants: string[];
  action: string;
  rule: string | null;
  op: string | null;
  reason: string | null;
  write?: boolean;
  risk?: string | null;
  deny?: { status: number; body: string; content_type: string };
}

interface AwsCase {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  region: string;
  service: string;
  credential: {
    access_key_id: string;
    secret_access_key: string;
    region: string;
    session_token?: string;
  };
  signed: Headers;
}

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/egress.json'), 'utf8'),
) as {
  now: string;
  decisions: DecisionCase[];
  aws: AwsCase[];
};
const now = new Date(
  Date.UTC(
    Number(fixtures.now.slice(0, 4)),
    Number(fixtures.now.slice(4, 6)) - 1,
    Number(fixtures.now.slice(6, 8)),
    Number(fixtures.now.slice(9, 11)),
    Number(fixtures.now.slice(11, 13)),
    Number(fixtures.now.slice(13, 15)),
  ),
);

describe('parity with the Python rules', () => {
  it('decides every fixture request as the Python rules do', () => {
    expect(fixtures.decisions.length).toBeGreaterThan(100);
    for (const c of fixtures.decisions) {
      const body = Buffer.from(c.body, 'base64');
      const label = `${c.method} ${c.host}${c.path} [${c.grants.join(',')}]`;
      const d = decide(c.method, c.host, c.path, c.headers, body, c.grants);
      expect([d.action, d.rule?.name ?? null, d.op, d.reason], label).toEqual([
        c.action,
        c.rule,
        c.op,
        c.reason,
      ]);
      if (c.action === 'inject') {
        expect(isWrite(d, c.method, c.path, body), label).toBe(c.write);
        const risk = highRisk(d, c.method, c.path, body);
        expect(risk ? risk[0] : null, label).toBe(c.risk);
      }
      if (c.deny) {
        const response = denyResponse(d, c.headers);
        expect(
          [response.status, response.body.toString(), response.headers['content-type']],
          label,
        ).toEqual([c.deny.status, c.deny.body, c.deny.content_type]);
      }
    }
  });

  it('signs AWS requests as botocore does', () => {
    expect(fixtures.aws.length).toBeGreaterThan(5);
    for (const c of fixtures.aws) {
      const signed = awsResign(
        c.method,
        c.url,
        c.headers,
        Buffer.from(c.body, 'base64'),
        c.region,
        c.service,
        c.credential,
        now,
      );
      expect(signed, c.url).toEqual(c.signed);
    }
  });
});
