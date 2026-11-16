import { type AwsCredential, awsResign } from '../sigv4/sign.ts';
import { awsScope, type Decision, type Headers } from './decide.ts';

/** What the vault hands the proxy for one grant; secrets only, no labels. */
export type Credential =
  ({ token: string } & Record<string, unknown>) | (AwsCredential & Record<string, unknown>);

/** Outgoing headers (lowercase keys) for an `inject` decision. */
export function apply(
  d: Decision,
  method: string,
  url: string,
  headers: Headers,
  body: Buffer,
  credential: Credential,
  now = new Date(),
): Headers {
  const rule = d.rule;
  if (rule === null) throw new Error('nothing to inject');
  if (rule.kind === 'aws_sigv4') {
    const scope = awsScope(headers);
    if (scope === null) throw new Error('unsigned AWS request');
    const [region, service] = scope;
    return awsResign(method, url, headers, body, region, service, credential as AwsCredential, now);
  }
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers))
    if (k !== 'authorization' && k !== 'proxy-authorization') out[k] = v;
  const token = String((credential as { token?: unknown }).token ?? '');
  if (rule.kind === 'bearer') out.authorization = `Bearer ${token}`;
  else if (rule.kind === 'basic')
    out.authorization = `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
  else if (rule.kind === 'raw') out.authorization = token;
  else if (rule.kind === 'bot') out.authorization = `Bot ${token}`;
  else if (rule.kind === 'figma') out['x-figma-token'] = token;
  else if (rule.kind === 'anthropic') {
    delete out['x-api-key'];
    if ((credential as { kind?: unknown }).kind === 'api_key') out['x-api-key'] = token;
    else out.authorization = `Bearer ${token}`;
  } else throw new Error(`rule ${rule.name} does not inject`);
  if (rule.name === 'codex')
    out['chatgpt-account-id'] = String((credential as { account_id?: unknown }).account_id ?? '');
  return out;
}
