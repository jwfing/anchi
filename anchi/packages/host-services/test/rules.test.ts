import { describe, expect, it } from 'vitest';
import {
  apply,
  awsChunkResigner,
  awsResign,
  ChunkResigner,
  classifyCredential,
  decide as decideRaw,
  denyResponse,
  egressAllowed,
  egressAllowlist,
  githubIdentity,
  highRisk,
  isWrite,
  listedRanges,
  PLACEHOLDER_AWS_KEY,
  PLACEHOLDER_CLAUDE_KEY,
  PLACEHOLDER_CLAUDE_OAUTH,
  PLACEHOLDER_MARK,
  publicAddress,
  signingKey,
  verifyAccount,
  verifyRequests,
  writeSummary,
} from '../src/index.ts';
import type { Headers } from '../src/rules/decide.ts';

const GITHUB = { token: 'ghp_fakefakefakefakefakefake', generation: 'g' };
const CODEX = { token: 'fake-codex-access', account_id: 'acct-123' };
const LINEAR = { token: 'lin_api_fakefakefakefakefake', generation: 'g' };
const AWS = {
  access_key_id: 'AKIAI44QH8DHBEXAMPLE',
  secret_access_key: 'fake/secret/key/0000000000',
  region: 'us-east-1',
};
const CLAUDE_OAUTH = { token: 'sk-ant-oat01-fakefakefakefakefakefakefakefake', kind: 'oauth' };
const CLAUDE_KEY = { token: 'sk-ant-api03-fakefakefakefakefakefakefakefake', kind: 'api_key' };
const FAKE = { token: 'fake-connector-token-0000', generation: 'g' };
const REST = ['posthog', 'sentry', 'firecrawl', 'figma', 'discord'] as const;
const ALL = new Set(['github', 'aws', 'linear', 'codex', 'claude', ...REST]);
const b = (s: string) => Buffer.from(s, 'utf8');

function decide(
  method: string,
  host: string,
  path: string,
  headers: Headers = {},
  body = Buffer.alloc(0),
  grants: Iterable<string> = ALL,
) {
  const lower: Headers = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return decideRaw(method, host, path, lower, body, [...grants]);
}

/** A request signed with the placeholder key, as the AWS CLI in a session would send it. */
function signed(
  service: string,
  opts: { region?: string; target?: string; body?: Buffer; path?: string; host?: string } = {},
) {
  const region = opts.region ?? 'us-east-1';
  const host = opts.host ?? `${service}.${region}.amazonaws.com`;
  const headers: Headers = {
    'content-type': opts.target
      ? 'application/x-amz-json-1.1'
      : 'application/x-www-form-urlencoded',
  };
  if (opts.target) headers['x-amz-target'] = opts.target;
  const out = awsResign(
    'POST',
    `https://${host}${opts.path ?? '/'}`,
    headers,
    opts.body ?? Buffer.alloc(0),
    region,
    service,
    {
      access_key_id: PLACEHOLDER_AWS_KEY,
      secret_access_key: 'anchi-placeholder-secret',
    },
  );
  return [host, out] as const;
}

/** A ChunkResigner keyed like the S3 reference's streaming examples (the documented example secret). */
function exampleResigner(seed: string, trailer: boolean) {
  const key = signingKey('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '20130524', 'us-east-1', 's3');
  return new ChunkResigner(
    key,
    '20130524T000000Z',
    '20130524/us-east-1/s3/aws4_request',
    seed,
    trailer,
  );
}

const pkt = (line: Buffer) =>
  Buffer.concat([b((line.length + 4).toString(16).padStart(4, '0')), line]);

/** A git-receive-pack body: ref updates [old, new, ref], a flush, then the pack. */
function gitPush(
  updates: [string, string, string][],
  caps = 'report-status side-band-64k',
  pack = b('PACK\0\0\0\u0002'),
) {
  const lines = updates.map(([o, n, r]) => b(`${o} ${n} ${r}`));
  lines[0] = Buffer.concat([lines[0]!, b(`\0${caps}`)]);
  return Buffer.concat([...lines.map((l) => pkt(Buffer.concat([l, b('\n')]))), b('0000'), pack]);
}

describe('decisions', () => {
  it('passes unmatched hosts through', () => {
    expect(decide('GET', 'example.com', '/').action).toBe('pass');
    expect(decide('GET', 'deb.debian.org', '/debian/dists').action).toBe('pass');
  });

  it('replaces only a Codex placeholder', () => {
    const placeholder = {
      authorization: `Bearer ${PLACEHOLDER_MARK}`,
      'chatgpt-account-id': 'acct-123',
    };
    const d = decide('POST', 'chatgpt.com', '/backend-api/codex/responses', placeholder);
    expect(d.action).toBe('inject');
    const headers = apply(d, 'POST', 'https://chatgpt.com/x', placeholder, Buffer.alloc(0), CODEX);
    expect(headers.authorization).toBe('Bearer fake-codex-access');
    expect(headers['chatgpt-account-id']).toBe('acct-123');
    expect(decide('GET', 'chatgpt.com', '/backend-api/codex/models').reason).toBe('no-placeholder');
    const other = decide('GET', 'chatgpt.com', '/x', { authorization: 'Bearer someone-else' });
    expect([other.action, other.reason]).toEqual(['pass', 'no-placeholder']);
  });

  it('denies ChatGPT apps and plugins', () => {
    const placeholder = { authorization: 'Bearer anchi-placeholder' };
    for (const [method, path] of [
      ['POST', '/backend-api/ps/mcp'],
      ['GET', '/backend-api/ps/plugins/list'],
      ['GET', '/backend-api/ps/plugins/installed?x=1'],
      ['GET', '/backend-api/plugins/featured'],
      ['GET', '/backend-api/aip/connectors/links'],
      ['GET', '/backend-api/connectors/directory/list'],
      ['POST', '/backend-api/ps'],
    ] as const) {
      for (const headers of [placeholder, {}])
        expect(decide(method, 'chatgpt.com', path, headers).action, path).toBe('deny');
    }
    for (const path of [
      '/backend-api/codex/responses',
      '/backend-api/codex/models',
      '/backend-api/wham/accounts/check',
      '/backend-api/psx',
    ]) {
      expect(decide('GET', 'chatgpt.com', path, placeholder).action, path).toBe('inject');
    }
  });

  it('replaces only a Claude placeholder, for either credential kind', () => {
    const oauth = {
      authorization: `Bearer ${PLACEHOLDER_CLAUDE_OAUTH}`,
      'anthropic-beta': 'oauth-2025-04-20',
    };
    let d = decide('POST', 'api.anthropic.com', '/v1/messages', oauth);
    expect(d.action).toBe('inject');
    let headers = apply(
      d,
      'POST',
      'https://api.anthropic.com/v1/messages',
      oauth,
      Buffer.alloc(0),
      CLAUDE_OAUTH,
    );
    expect(headers.authorization).toBe(`Bearer ${CLAUDE_OAUTH.token}`);
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    const key = { 'x-api-key': PLACEHOLDER_CLAUDE_KEY };
    d = decide('POST', 'api.anthropic.com', '/v1/messages', key);
    headers = apply(
      d,
      'POST',
      'https://api.anthropic.com/v1/messages',
      key,
      Buffer.alloc(0),
      CLAUDE_KEY,
    );
    expect(headers['x-api-key']).toBe(CLAUDE_KEY.token);
    expect(headers.authorization).toBeUndefined();
    expect(decide('GET', 'api.anthropic.com', '/mcp-registry/v0/servers').reason).toBe(
      'no-placeholder',
    );
    const codexOnly = decide('POST', 'api.anthropic.com', '/v1/messages', oauth, Buffer.alloc(0), [
      'codex',
    ]);
    expect([codexOnly.action, codexOnly.reason]).toEqual(['pass', 'not-granted']);
    expect(decide('POST', 'api.anthropic.com', '/v1/organizations/api_keys', oauth).action).toBe(
      'deny',
    );
    expect(decide('POST', 'console.anthropic.com', '/v1/oauth/token').action).toBe('deny');
    expect(decide('POST', 'claude.ai', '/v1/oauth/token').action).toBe('deny');
  });

  it('denies token refresh for everyone', () => {
    for (const grants of [ALL, new Set<string>()]) {
      expect(
        decide('POST', 'auth.openai.com', '/oauth/token', {}, Buffer.alloc(0), grants).action,
      ).toBe('deny');
    }
  });

  it('injects a GitHub bearer and denies the key endpoints', () => {
    const d = decide('GET', 'api.github.com', '/repos/o/r/issues', {
      authorization: 'token anchi-placeholder',
    });
    expect(d.action).toBe('inject');
    const headers = apply(
      d,
      'GET',
      'https://api.github.com/x',
      { authorization: 'x' },
      Buffer.alloc(0),
      GITHUB,
    );
    expect(headers.authorization).toBe(`Bearer ${GITHUB.token}`);
    expect(decide('GET', 'api.github.com', '/user').action).toBe('inject');
    expect(decide('POST', 'api.github.com', '/graphql').action).toBe('inject');
    for (const [method, path] of [
      ['POST', '/user/keys'],
      ['POST', '/repos/o/r/keys'],
      ['POST', '/app/installations/1/access_tokens'],
      ['PUT', '/repos/o/r/actions/secrets/X'],
      ['GET', '/orgs/o/actions/secrets'],
      ['PUT', '/repos/o/r/environments/prod/secrets/X'],
    ] as const) {
      expect(decide(method, 'api.github.com', path).action, path).toBe('deny');
    }
  });

  it('injects git basic credentials on smart HTTP only', () => {
    let d = decide('GET', 'github.com', '/');
    for (const path of [
      '/o/r.git/info/refs?service=git-upload-pack',
      '/o/r/git-receive-pack',
      '/o/r.git/git-upload-pack',
    ]) {
      d = decide('GET', 'github.com', path);
      expect(d.action, path).toBe('inject');
    }
    const headers = apply(
      d,
      'POST',
      'https://github.com/o/r.git/git-upload-pack',
      {},
      Buffer.alloc(0),
      GITHUB,
    );
    const [user, token] = Buffer.from(headers.authorization!.slice(6), 'base64')
      .toString()
      .split(':');
    expect([user, token]).toEqual(['x-access-token', GITHUB.token]);
    for (const path of ['/o/r/releases/download/v1/x.tgz', '/login', '/o/r']) {
      expect(decide('GET', 'github.com', path).action, path).toBe('pass');
    }
  });

  it('gives a session without the connector no injection', () => {
    for (const [host, path] of [
      ['api.github.com', '/user'],
      ['github.com', '/o/r/info/refs'],
      ['api.linear.app', '/graphql'],
    ] as const) {
      const d = decide(
        'GET',
        host,
        path,
        { authorization: 'Bearer anchi-placeholder' },
        Buffer.alloc(0),
        ['codex'],
      );
      expect([d.action, d.reason], host).toEqual(['pass', 'not-granted']);
    }
  });

  it('injects the Linear raw key and denies key minting', () => {
    const body = b(JSON.stringify({ query: 'query { issue(id: "X-1") { title } }' }));
    const d = decide('POST', 'api.linear.app', '/graphql', {}, body);
    expect([d.action, d.op]).toEqual(['inject', 'graphql:query,issue']);
    const headers = apply(d, 'POST', 'https://api.linear.app/graphql', {}, body, LINEAR);
    expect(headers.authorization).toBe(LINEAR.token);
    const mint = b(
      JSON.stringify({ query: 'mutation { apiKeyCreate(input: {label: "x"}) { apiKey { id } } }' }),
    );
    expect(decide('POST', 'api.linear.app', '/graphql', {}, mint).action).toBe('deny');
  });

  it('injects each REST connector header into its own API only', () => {
    for (const [host, path, header, value] of [
      ['us.posthog.com', '/api/projects/1/insights/', 'authorization', `Bearer ${FAKE.token}`],
      ['eu.posthog.com', '/api/users/@me/', 'authorization', `Bearer ${FAKE.token}`],
      ['sentry.io', '/api/0/organizations/', 'authorization', `Bearer ${FAKE.token}`],
      ['de.sentry.io', '/api/0/projects/o/p/issues/', 'authorization', `Bearer ${FAKE.token}`],
      ['api.firecrawl.dev', '/v2/scrape', 'authorization', `Bearer ${FAKE.token}`],
      ['api.figma.com', '/v1/files/abc', 'x-figma-token', FAKE.token],
      ['discord.com', '/api/v10/channels/1/messages', 'authorization', `Bot ${FAKE.token}`],
      ['discord.com', '/api/v10/webhooks/1/webhook-token', 'authorization', `Bot ${FAKE.token}`],
    ] as const) {
      const d = decide('GET', host, path);
      expect(d.action, host).toBe('inject');
      const sent = { [header]: 'anchi-placeholder', accept: 'application/json' };
      const headers = apply(d, 'GET', `https://${host}${path}`, sent, Buffer.alloc(0), FAKE);
      expect(headers, host).toEqual({ [header]: value, accept: 'application/json' });
      expect(decide('GET', host, path, {}, Buffer.alloc(0), ['codex']).reason).toBe('not-granted');
    }
    for (const [host, path] of [
      ['sentry.io', '/api/123/envelope/'],
      ['discord.com', '/channels/1/2'],
      ['us.posthog.com', '/project/1/insights'],
      ['us.i.posthog.com', '/capture/'],
    ] as const) {
      expect(decide('POST', host, path).action, host).toBe('pass');
    }
    for (const [method, host, path] of [
      ['POST', 'us.posthog.com', '/api/personal_api_keys/'],
      ['POST', 'eu.posthog.com', '/api/personal_api_keys/k1/roll/'],
      ['GET', 'us.posthog.com', '/api/personal_api_keys'],
      ['PATCH', 'us.posthog.com', '/api/projects/1/reset_token/'],
      ['PATCH', 'us.posthog.com', '/api/environments/1/rotate_secret_token/'],
      ['POST', 'sentry.io', '/api/0/api-tokens/'],
      ['GET', 'us.sentry.io', '/api/0/api-tokens/'],
      ['POST', 'sentry.io', '/api/0/organizations/o/org-auth-tokens/'],
      ['POST', 'sentry.io', '/api/0/sentry-apps/app/api-tokens/'],
      ['POST', 'sentry.io', '/api/0/sentry-apps/app/rotate-secret/'],
      ['POST', 'sentry.io', '/api/0/sentry-app-installations/i1/authorizations/'],
      ['GET', 'discord.com', '/api/v10/channels/1/webhooks'],
      ['POST', 'discord.com', '/api/channels/1/webhooks'],
      ['GET', 'discord.com', '/api/v10/guilds/1/webhooks'],
      ['GET', 'discordapp.com', '/api/v9/webhooks/1'],
      ['PATCH', 'discord.com', '/api/v10/webhooks/1/'],
      ['POST', 'discord.com', '/api/v10/oauth2/token'],
    ] as const) {
      expect(decide(method, host, path).action, `${method} ${host}${path}`).toBe('deny');
    }
    for (const [method, host, path] of [
      ['GET', 'us.posthog.com', '/api/projects/1/'],
      ['GET', 'sentry.io', '/api/0/organizations/o/projects/'],
      ['POST', 'discord.com', '/api/v10/channels/1/messages'],
    ] as const) {
      expect(decide(method, host, path).action, path).toBe('inject');
    }
  });

  it('recognizes placeholders in each token alphabet and reveals nothing', () => {
    for (const headers of [
      { authorization: 'lin_api_anchiplaceholder0000' },
      { authorization: 'Bot MTAwMDAwMDAwMDAwMDAwMDAw.AAAAAA.anchiplaceholder0000000000000000' },
      { 'x-figma-token': 'figd_anchi-placeholder' },
      { authorization: 'Bearer anchi-placeholder-x' },
      { authorization: `Basic ${Buffer.from('x:anchi-placeholder').toString('base64')}` },
    ] as Headers[]) {
      expect(classifyCredential(headers), JSON.stringify(headers)).toBe('placeholder');
    }
    expect(classifyCredential({ 'x-figma-token': `figd_${'a'.repeat(40)}` })).toBe('other');
    expect(classifyCredential({})).toBe('none');
    expect(classifyCredential({ authorization: 'Bearer real' })).toBe('other');
  });

  it('re-signs signed AWS requests only, with the session token signed in', () => {
    const body = b('{"logGroupName":"/app"}');
    const [host, headers] = signed('logs', { target: 'Logs_20140328.FilterLogEvents', body });
    const d = decide('POST', host, '/', headers, body);
    expect([d.action, d.op]).toEqual(['inject', 'logs:FilterLogEvents']);
    const fresh = apply(d, 'POST', `https://${host}/`, headers, body, AWS);
    expect(fresh.authorization).toContain(`Credential=${AWS.access_key_id}/`);
    expect(JSON.stringify(fresh)).not.toContain(PLACEHOLDER_AWS_KEY);
    expect(fresh['x-amz-security-token']).toBeUndefined();
    expect(decide('GET', 'awscli.amazonaws.com', '/awscli.zip').reason).toBe('unsigned');
    const sts = b('Action=GetCallerIdentity&Version=2011-06-15');
    const [stsHost, stsHeaders] = signed('sts', { body: sts });
    const withSession = apply(
      decide('POST', stsHost, '/', stsHeaders, sts),
      'POST',
      `https://${stsHost}/`,
      stsHeaders,
      sts,
      {
        ...AWS,
        session_token: 'fake-session',
      },
    );
    expect(withSession['x-amz-security-token']).toBe('fake-session');
    expect(withSession.authorization).toContain('x-amz-security-token');
  });

  it('denies AWS credential minting in the service error shape', () => {
    for (const [service, body] of [
      ['sts', b('Action=GetSessionToken&Version=2011-06-15')],
      ['sts', b('Action=AssumeRole&Version=2011-06-15')],
      ['iam', b('Action=CreateAccessKey&Version=2010-05-08')],
    ] as const) {
      const [host, headers] = signed(service, { body });
      const d = decide('POST', host, '/', headers, body);
      expect(d.action, body.toString()).toBe('deny');
      const response = denyResponse(d, headers);
      expect([response.status, response.headers['content-type']]).toEqual([403, 'text/xml']);
      expect(response.body.toString()).toContain('<Code>AccessDenied</Code>');
    }
    const [host, headers] = signed('sso', { target: 'SWBPortalService.GetRoleCredentials' });
    const response = denyResponse(decide('POST', host, '/', headers), headers);
    expect(JSON.parse(response.body.toString()).__type).toBe('AccessDeniedException');
    const list = b('Action=ListUsers&Version=2010-05-08');
    const [iam, iamHeaders] = signed('iam', { body: list });
    expect(decide('POST', iam, '/', iamHeaders, list).action).toBe('inject');
  });

  it('matches the chunk signatures of the AWS examples', () => {
    const seed = '4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9';
    const expected = [
      'ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648',
      '0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497',
      'b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9',
    ];
    const placeholder = '0'.repeat(64);
    const body = Buffer.concat(
      [Buffer.alloc(65536, 'a'), Buffer.alloc(1024, 'a'), Buffer.alloc(0)].map((c) =>
        Buffer.concat([
          b(`${c.length.toString(16)};chunk-signature=${placeholder}\r\n`),
          c,
          b('\r\n'),
        ]),
      ),
    );
    for (const step of [body.length, 1, 7, 4096]) {
      const resigner = exampleResigner(seed, false);
      const parts: Buffer[] = [];
      for (let i = 0; i < body.length; i += step)
        parts.push(resigner.feed(body.subarray(i, i + step)));
      parts.push(resigner.feed(Buffer.alloc(0)));
      const out = Buffer.concat(parts);
      expect(out.length).toBe(body.length);
      const signatures = out
        .toString('latin1')
        .split('\r\n')
        .filter((line) => line.includes('chunk-signature'))
        .map((line) => line.split('=')[1]);
      expect(signatures).toEqual(expected);
      expect(out.toString('latin1').replace(/a/g, '').split('\r\n').length - 1).toBe(6);
    }
    const trailerSeed = '106e2a8a18243abcf37539882f36619c00e2dfc72633413f02d3b74544bfeb8e';
    const trailerBody = Buffer.concat([
      b(`10000;chunk-signature=${placeholder}\r\n`),
      Buffer.alloc(65536, 'a'),
      b(`\r\n400;chunk-signature=${placeholder}\r\n`),
      Buffer.alloc(1024, 'a'),
      b(`\r\n0;chunk-signature=${placeholder}\r\n`),
      b(`x-amz-checksum-crc32c:sOO8/Q==\r\nx-amz-trailer-signature:${placeholder}\r\n\r\n`),
    ]);
    const resigner = exampleResigner(trailerSeed, true);
    const out = Buffer.concat([
      resigner.feed(trailerBody.subarray(0, 70000)),
      resigner.feed(trailerBody.subarray(70000)),
      resigner.feed(Buffer.alloc(0)),
    ]);
    expect(out.length).toBe(trailerBody.length);
    const signatures = out
      .toString('latin1')
      .split('\r\n')
      .filter((line) => line.includes('chunk-signature'))
      .map((line) => line.split('=')[1]);
    expect(signatures).toEqual([
      'b474d8862b1487a5145d686f57f013e54db672cee1c953b3010fb58501ef5aa2',
      '1c1344b170168f8e65b41376b44b20fe354e373826ccbbe2c1d40a8cae51e5c7',
      '2ca2aba2005185cf7159c6277faf83795951dd77a3a99e6e65d5c9f85863f992',
    ]);
    expect(out.toString('latin1').split('x-amz-trailer-signature:')[1]).toMatch(
      /^[0-9a-f]{64}\r\n\r\n$/,
    );
    expect(out.toString('latin1')).not.toContain(placeholder);
  });

  it('refuses malformed aws-chunked bodies', () => {
    const sig = '0'.repeat(64);
    for (const body of [
      b(`zz;chunk-signature=${sig}\r\n`),
      b(`1000001;chunk-signature=${sig}\r\n`),
      b(`1;chunk-signature=${sig}\r\naXX`),
      Buffer.alloc(200, 'x'),
    ]) {
      expect(() => exampleResigner(sig, false).feed(body)).toThrow();
    }
    let resigner = exampleResigner(sig, false);
    resigner.feed(b(`1;chunk-signature=${sig}\r\na\r\n`));
    expect(() => resigner.feed(Buffer.alloc(0))).toThrow(/truncated/);
    expect(() => exampleResigner(sig, false).feed(Buffer.alloc(0))).toThrow();
    resigner = exampleResigner(sig, false);
    resigner.feed(b(`0;chunk-signature=${sig}\r\n\r\n`));
    expect(() => resigner.feed(b('more'))).toThrow(/after the final/);
  });

  it('re-signs streaming payloads and refuses unknown kinds', () => {
    const [host, headers] = signed('s3', { host: 'bucket.s3.amazonaws.com' });
    for (const [payload, chunked] of [
      ['STREAMING-UNSIGNED-PAYLOAD-TRAILER', false],
      ['STREAMING-AWS4-HMAC-SHA256-PAYLOAD', true],
      ['STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER', true],
    ] as const) {
      const sent = {
        ...headers,
        'x-amz-content-sha256': payload,
        'content-encoding': 'aws-chunked',
      };
      const d = decide('PUT', host, '/key', sent);
      const fresh = apply(d, 'PUT', `https://${host}/key`, sent, Buffer.alloc(0), AWS);
      expect(fresh['x-amz-content-sha256']).toBe(payload);
      expect(fresh.authorization).toContain('x-amz-content-sha256');
      expect(fresh.authorization).toContain(`Credential=${AWS.access_key_id}/`);
      const resigner = awsChunkResigner(fresh, AWS);
      expect(resigner !== null).toBe(chunked);
      if (resigner) expect(resigner.previous).toBe(fresh.authorization!.split('Signature=').at(-1));
    }
    const sent = { ...headers, 'x-amz-content-sha256': 'STREAMING-AWS4-ECDSA-P256-SHA256-PAYLOAD' };
    expect(() =>
      apply(
        decide('PUT', host, '/key', sent),
        'PUT',
        `https://${host}/key`,
        sent,
        Buffer.alloc(0),
        AWS,
      ),
    ).toThrow();
  });

  it('names S3 subresources in the operation and its risk', () => {
    const [host, headers] = signed('s3', { host: 's3.us-east-1.amazonaws.com' });
    for (const [method, path, op, risk] of [
      ['POST', '/bucket?delete', 's3:POST /bucket?delete', 'aws-s3-delete'],
      ['PUT', '/bucket?lifecycle', 's3:PUT /bucket?lifecycle', 'aws-s3-delete'],
      ['PUT', '/bucket?policy', 's3:PUT /bucket?policy', 'aws-s3-access'],
      ['PUT', '/bucket/key?acl', 's3:PUT /bucket/key?acl', 'aws-s3-access'],
      ['DELETE', '/bucket/key', 's3:DELETE /bucket/key', 'aws-s3-delete'],
      ['PUT', '/bucket/key?partNumber=1&uploadId=x', 's3:PUT /bucket/key', null],
      ['GET', '/bucket?list-type=2', 's3:GET /bucket', null],
    ] as const) {
      const d = decide(method, host, path, headers);
      expect(d.op).toBe(op);
      const found = highRisk(d, method, path, Buffer.alloc(0));
      expect(found && found[0], path).toBe(risk);
    }
  });

  it('never forwards proxy-authorization', () => {
    const d = decide('GET', 'api.github.com', '/user');
    const headers = apply(
      d,
      'GET',
      'https://api.github.com/user',
      { 'proxy-authorization': 'x' },
      Buffer.alloc(0),
      GITHUB,
    );
    expect(headers['proxy-authorization']).toBeUndefined();
  });

  it('builds verification requests and reads accounts', () => {
    const [linear] = verifyRequests('linear', LINEAR);
    expect([linear!.method, linear!.url, linear!.headers.authorization]).toEqual([
      'POST',
      'https://api.linear.app/graphql',
      LINEAR.token,
    ]);
    const [aws] = verifyRequests('aws', AWS);
    expect(aws!.url).toBe('https://sts.us-east-1.amazonaws.com/');
    expect(aws!.headers.authorization).toContain(`Credential=${AWS.access_key_id}/`);
    expect(aws!.body.toString()).toBe('Action=GetCallerIdentity&Version=2011-06-15');
    expect(verifyAccount('github', 200, b('{"login":"octo"}'))).toBe('octo');
    expect(
      verifyAccount('linear', 200, b('{"data":{"viewer":{"email":"a@b.c","name":"A"}}}')),
    ).toBe('a@b.c');
    expect(verifyAccount('aws', 200, b('<R><Arn>arn:aws:iam::1:user/bot</Arn></R>'))).toBe(
      'arn:aws:iam::1:user/bot',
    );
    for (const [connector, status, body] of [
      ['github', 401, '{"message":"Bad credentials"}'],
      ['aws', 403, '<Error/>'],
      ['linear', 200, '{"errors":[{"message":"Authentication required"}]}'],
    ] as const) {
      expect(() => verifyAccount(connector, status, b(body))).toThrow(/CREDENTIAL_REJECTED/);
    }
    expect(() => verifyAccount('github', 200, b('<html>'))).toThrow(/VERIFY_UNEXPECTED_RESPONSE/);
    const calls = Object.fromEntries(REST.map((c) => [c, verifyRequests(c, FAKE)]));
    expect(calls.posthog!.map((r) => r.url)).toEqual([
      'https://us.posthog.com/api/users/@me/',
      'https://eu.posthog.com/api/users/@me/',
    ]);
    expect(calls.figma![0]!.headers['x-figma-token']).toBe(FAKE.token);
    expect(calls.discord![0]!.headers.authorization).toBe(`Bot ${FAKE.token}`);
    for (const connector of ['posthog', 'sentry', 'firecrawl'] as const) {
      expect(calls[connector]![0]!.headers.authorization).toBe(`Bearer ${FAKE.token}`);
    }
    for (const requests of Object.values(calls)) {
      for (const { method, url } of requests) {
        const [host, ...rest] = url.slice('https://'.length).split('/');
        expect(method).toBe('GET');
        expect(decide(method, host!, `/${rest.join('/')}`).action, url).toBe('inject');
      }
    }
    expect(
      verifyAccount(
        'posthog',
        200,
        b('{"email":"a@b.c"}'),
        'https://eu.posthog.com/api/users/@me/',
      ),
    ).toBe('a@b.c (EU)');
    expect(verifyAccount('sentry', 200, b('[{"slug":"acme"},{"slug":"beta"}]'))).toBe('acme, beta');
    expect(
      verifyAccount('firecrawl', 200, b('{"success":true,"data":{"remainingCredits":500}}')),
    ).toBe('team with 500 credits left');
    expect(verifyAccount('figma', 200, b('{"handle":"ann","email":"ann@x.y"}'))).toBe('ann@x.y');
    expect(verifyAccount('discord', 200, b('{"id":"1","username":"helper","bot":true}'))).toBe(
      'helper',
    );
    expect(() => verifyAccount('sentry', 200, b('[]'))).toThrow(/CREDENTIAL_REJECTED/);
    for (const connector of REST) {
      expect(() => verifyAccount(connector, 401, b('{}'))).toThrow(/CREDENTIAL_REJECTED/);
      expect(() => verifyAccount(connector, 200, b('{"unexpected": 1}'))).toThrow(
        /VERIFY_UNEXPECTED_RESPONSE/,
      );
    }
  });

  it('keeps only bounded fields of the GitHub identity', () => {
    expect(
      githubIdentity(
        200,
        b('{"login":"octo-cat","id":583231,"name":"Mona Lisa","email":"m@x.y","token":"t"}'),
      ),
    ).toEqual({
      github_login: 'octo-cat',
      github_id: 583231,
      github_name: 'Mona Lisa',
    });
    expect(githubIdentity(200, b('{"login":"octo","id":1,"name":null}'))!.github_name).toBe('octo');
    expect(githubIdentity(200, b('{"login":"octo","id":1,"name":"$<>"}'))!.github_name).toBe(
      'octo',
    );
    const name = githubIdentity(
      200,
      b('{"login":"o","id":1,"name":"A\\n$HOME \\u202e<b@c> `x` %h\\\\"}'),
    )!.github_name;
    expect(name).toBe('A HOME b@c x h');
    expect(
      githubIdentity(200, b(`{"login":"o","id":1,"name":"${'n'.repeat(500)}"}`))!.github_name
        .length,
    ).toBe(100);
    for (const [status, body] of [
      [401, b('{"login":"octo","id":1}')],
      [200, b('<html>')],
      [200, b('[]')],
      [200, b('{"id":1}')],
      [200, b('{"login":"octo"}')],
      [200, b('{"login":"octo","id":true}')],
      [200, b('{"login":"octo","id":"1"}')],
      [200, b('{"login":"octo","id":-1}')],
      [200, b('{"login":"octo","id":9007199254740993}')],
      [200, b('{"login":"-octo","id":1}')],
      [200, b('{"login":"oc to","id":1}')],
      [200, b('{"login":"$(id)","id":1}')],
      [200, b(`{"login":"${'a'.repeat(40)}","id":1}`)],
      [200, Buffer.from([0xff, 0xfe])],
    ] as const) {
      expect(githubIdentity(status, body), body.toString('latin1')).toBeNull();
    }
  });

  it('classifies writes for approval', () => {
    const write = (
      method: string,
      host: string,
      path: string,
      body = Buffer.alloc(0),
      headers: Headers = {},
    ) => isWrite(decide(method, host, path, headers, body), method, path, body);
    expect(write('POST', 'github.com', '/o/r.git/git-receive-pack')).toBe(true);
    expect(write('POST', 'github.com', '/o/r.git/git-upload-pack')).toBe(false);
    expect(write('POST', 'api.github.com', '/repos/o/r/pulls')).toBe(true);
    expect(write('GET', 'api.github.com', '/repos/o/r/pulls')).toBe(false);
    expect(
      write('POST', 'api.github.com', '/graphql', b('{"query": "query { viewer { login } }"}')),
    ).toBe(false);
    expect(
      write('POST', 'api.github.com', '/graphql', b('{"query": "mutation { addComment }"}')),
    ).toBe(true);
    expect(
      write('POST', 'api.linear.app', '/graphql', b('{"query":"mutation { commentCreate }"}')),
    ).toBe(true);
    expect(
      write('POST', 'api.linear.app', '/graphql', b('{"query":"{ issue(id: 1) { title } }"}')),
    ).toBe(false);
    const graphql = (query: string) => b(`{"query": ${JSON.stringify(query)}}`);
    for (const query of [
      '# a comment first\nmutation { addComment }',
      '﻿mutation { addComment }',
      ', mutation { addComment }',
      'query A { viewer { login } } mutation B { addComment }',
      'fragment F on Repository { id } mutation { addComment }',
      'mutation{addComment}',
      '"""a description"""\nmutation { addComment }',
      '# mutation\nmutation { addComment }',
    ]) {
      expect(write('POST', 'api.github.com', '/graphql', graphql(query)), query).toBe(true);
      expect(write('POST', 'api.linear.app', '/graphql', graphql(query)), query).toBe(true);
    }
    for (const query of [
      'query { search(query: "mutation { x }") { x } }',
      '# mutation\nquery { viewer { login } }',
      '{ issue(id: 1) { mutation } }',
      'query Q($m: String = "mutation") { f(m: $m) }',
      '"""mutation""" query { viewer { login } }',
    ]) {
      expect(write('POST', 'api.github.com', '/graphql', graphql(query)), query).toBe(false);
    }
    for (const body of [
      b('not json'),
      b('{}'),
      b('{"query": null}'),
      b('{"query": 1}'),
      b('{"query": "  "}'),
      b('[{"query": "{ viewer { login } }"}]'),
      b(`{"query": "${'{ a '.repeat(250_001)}"}`),
    ]) {
      expect(
        write('POST', 'api.github.com', '/graphql', body),
        body.subarray(0, 40).toString(),
      ).toBe(true);
    }
    let [host, headers] = signed('logs', { target: 'Logs_20140328.FilterLogEvents' });
    expect(write('POST', host, '/', Buffer.alloc(0), headers)).toBe(false);
    [host, headers] = signed('logs', { target: 'Logs_20140328.DeleteLogGroup' });
    expect(write('POST', host, '/', Buffer.alloc(0), headers)).toBe(true);
    expect(write('POST', 'us.posthog.com', '/api/projects/1/query/')).toBe(false);
    expect(write('POST', 'eu.posthog.com', '/api/environments/1/query')).toBe(false);
    expect(write('POST', 'us.posthog.com', '/api/projects/1/insights/')).toBe(true);
    expect(write('POST', 'us.posthog.com', '/api/projects/1/query/x/')).toBe(true);
    expect(write('PUT', 'sentry.io', '/api/0/issues/1/')).toBe(true);
    expect(write('GET', 'sentry.io', '/api/0/issues/1/')).toBe(false);
    expect(write('POST', 'api.firecrawl.dev', '/v2/scrape')).toBe(true);
    expect(write('POST', 'api.figma.com', '/v1/files/abc/comments')).toBe(true);
    expect(write('GET', 'api.figma.com', '/v1/files/abc')).toBe(false);
    expect(write('POST', 'discord.com', '/api/v10/channels/1/messages')).toBe(true);
  });

  it('recognizes high-risk operations for every session', () => {
    const risk = (
      method: string,
      host: string,
      path: string,
      body = Buffer.alloc(0),
      headers: Headers = {},
      disabled: string[] = [],
    ) => {
      const found = highRisk(
        decide(method, host, path, headers, body),
        method,
        path,
        body,
        disabled,
      );
      return found && found[0];
    };
    const push = (ref: string, now = '1'.repeat(40)) => gitPush([['2'.repeat(40), now, ref]]);
    expect(risk('PUT', 'api.github.com', '/repos/o/r/pulls/7/merge')).toBe('github-merge');
    expect(risk('DELETE', 'api.github.com', '/repos/o/r')).toBe('github-repo-delete');
    expect(risk('POST', 'github.com', '/o/r.git/git-receive-pack', push('refs/heads/main'))).toBe(
      'git-default-branch',
    );
    expect(
      risk(
        'POST',
        'github.com',
        '/o/r.git/git-receive-pack',
        push('refs/heads/fix', '0'.repeat(40)),
      ),
    ).toBe('git-ref-delete');
    expect(
      risk('POST', 'github.com', '/o/r.git/git-receive-pack', push('refs/heads/fix')),
    ).toBeNull();
    const many: [string, string, string][] = Array.from({ length: 500 }, (_, i) => [
      '2'.repeat(40),
      '1'.repeat(40),
      `refs/heads/f${i}`,
    ]);
    expect(
      risk(
        'POST',
        'github.com',
        '/o/r.git/git-receive-pack',
        gitPush([...many.slice(0, 300), ['2'.repeat(40), '1'.repeat(40), 'refs/heads/main']]),
      ),
    ).toBe('git-default-branch');
    for (const body of [
      gitPush([...many, ...many, ...many]),
      b('refs/heads/fix'),
      gitPush([['2'.repeat(40), '1'.repeat(40), 'refs/heads/fix']]).subarray(0, 60),
    ]) {
      expect(risk('POST', 'github.com', '/o/r.git/git-receive-pack', body)).toBe(
        'github-push-unreadable',
      );
    }
    expect(
      risk(
        'POST',
        'api.github.com',
        '/graphql',
        b('{"query":"mutation { mergePullRequest(input: {}) { x } }"}'),
      ),
    ).toBe('github-graphql');
    expect(
      risk('POST', 'api.github.com', '/graphql', b('{"query":"query { viewer { login } }"}')),
    ).toBeNull();
    expect(
      risk(
        'POST',
        'api.github.com',
        '/graphql',
        b(
          '{"query":"# first\\nquery Q { viewer { login } } mutation M { mergePullRequest(input: {}) { x } }"}',
        ),
      ),
    ).toBe('github-graphql');
    expect(
      risk(
        'POST',
        'api.linear.app',
        '/graphql',
        b('{"query":"query { x } mutation { issueDelete(id: 1) { s } }"}'),
      ),
    ).toBe('linear-delete');
    expect(
      risk('POST', 'api.github.com', '/graphql', b('{"query":"query { mergePullRequest { x } }"}')),
    ).toBeNull();
    for (const body of [
      b('not json'),
      b('[{"query": "mutation { mergePullRequest(input: {}) { x } }"}]'),
      b(`{"query": "${'{ a '.repeat(250_001)}"}`),
    ]) {
      expect(risk('POST', 'api.github.com', '/graphql', body)).toBe('github-graphql-unreadable');
      expect(
        risk('POST', 'api.github.com', '/graphql', body, {}, ['github-graphql-unreadable']),
      ).toBe('github-graphql-unreadable');
    }
    expect(risk('POST', 'api.github.com', '/repos/o/r/pulls')).toBeNull();
    let [host, headers] = signed('logs', { target: 'Logs_20140328.DeleteLogGroup' });
    expect(risk('POST', host, '/', Buffer.alloc(0), headers)).toBe('aws-destroy');
    [host, headers] = signed('logs', { target: 'Logs_20140328.FilterLogEvents' });
    expect(risk('POST', host, '/', Buffer.alloc(0), headers)).toBeNull();
    expect(
      risk(
        'POST',
        'api.linear.app',
        '/graphql',
        b('{"query":"mutation { issueDelete(id: 1) { success } }"}'),
      ),
    ).toBe('linear-delete');
    expect(
      risk('PUT', 'api.github.com', '/repos/o/r/pulls/7/merge', Buffer.alloc(0), {}, [
        'github-merge',
      ]),
    ).toBeNull();
    for (const [method, h, path, entry] of [
      ['DELETE', 'us.posthog.com', '/api/projects/1/', 'posthog-delete'],
      ['DELETE', 'eu.posthog.com', '/api/organizations/o1', 'posthog-delete'],
      ['POST', 'us.posthog.com', '/api/organizations/o1/invites/', 'posthog-access'],
      ['DELETE', 'us.posthog.com', '/api/organizations/o1/members/u1/', 'posthog-access'],
      ['DELETE', 'sentry.io', '/api/0/projects/o/p/', 'sentry-delete'],
      ['DELETE', 'sentry.io', '/api/0/organizations/o/', 'sentry-delete'],
      ['POST', 'sentry.io', '/api/0/organizations/o/members/', 'sentry-access'],
      ['POST', 'api.figma.com', '/v2/webhooks', 'figma-webhook'],
      ['PUT', 'api.figma.com', '/v2/webhooks/w1', 'figma-webhook'],
      ['DELETE', 'discord.com', '/api/v10/channels/1', 'discord-delete'],
      ['DELETE', 'discord.com', '/api/guilds/1', 'discord-delete'],
      ['PUT', 'discord.com', '/api/v10/guilds/1/bans/2', 'discord-members'],
      ['DELETE', 'discord.com', '/api/v10/guilds/1/members/2', 'discord-members'],
      ['PUT', 'discord.com', '/api/v10/guilds/1/members/2/roles/3', 'discord-members'],
      ['POST', 'discord.com', '/api/v10/guilds/1/roles', 'discord-access'],
      ['PUT', 'discord.com', '/api/v10/channels/1/permissions/2', 'discord-access'],
      ['PATCH', 'discord.com', '/api/v10/guilds/1', 'discord-access'],
      ['PATCH', 'discord.com', '/api/v10/applications/@me', 'discord-access'],
    ] as const) {
      expect(risk(method, h, path), `${method} ${h}${path}`).toBe(entry);
    }
    for (const [method, h, path] of [
      ['DELETE', 'us.posthog.com', '/api/projects/1/insights/2/'],
      ['DELETE', 'sentry.io', '/api/0/issues/1/'],
      ['GET', 'api.figma.com', '/v2/webhooks'],
      ['DELETE', 'discord.com', '/api/v10/channels/1/messages/2'],
      ['PATCH', 'discord.com', '/api/v10/guilds/1/members/@me'],
      ['POST', 'api.firecrawl.dev', '/v2/crawl'],
    ] as const) {
      expect(risk(method, h, path), `${method} ${h}${path}`).toBeNull();
    }
  });

  it('names the refs of a push in its summary', () => {
    const d = decide('POST', 'github.com', '/o/r.git/git-receive-pack');
    let body = Buffer.concat([
      b('00a8'),
      b('0'.repeat(40)),
      b(' '),
      b('1'.repeat(40)),
      b(' refs/heads/fix-12\0 report-status\n0000PACK...'),
    ]);
    expect(writeSummary(d, 'POST', '/o/r', body)).toBe('git push: refs/heads/fix-12');
    body = Buffer.concat([
      b('00d8'),
      b('a'.repeat(64)),
      b(' '),
      b('b'.repeat(64)),
      b(' refs/heads/sha256\0 report-status\n0000PACK...'),
    ]);
    expect(writeSummary(d, 'POST', '/o/r', body)).toBe('git push: refs/heads/sha256');
    expect(writeSummary(d, 'POST', '/o/r', b('0000'))).toBe('git push: no ref updates found');
    const api = decide('POST', 'api.github.com', '/repos/o/r/issues');
    expect(writeSummary(api, 'POST', '/repos/o/r/issues', b('{"title":"x"}'))).toBe(
      'POST /repos/o/r/issues\n{"title":"x"}',
    );
    expect(writeSummary(api, 'POST', '/repos/o/r/issues', Buffer.from([1, 0, 2]))).toBe(
      'POST /repos/o/r/issues (binary body, 3 bytes)',
    );
  });

  it('builds egress lists from grants and matches hosts', () => {
    expect(egressAllowlist(null, ['github'])).toBeNull();
    const list = egressAllowlist(['Example.com', '*.cdn.example.com'], ['github', 'aws'])!;
    for (const host of [
      'example.com',
      'a.cdn.example.com',
      'api.github.com',
      'x.githubusercontent.com',
      'S3.amazonaws.com',
    ]) {
      expect(egressAllowed(list, host), host).toBe(true);
    }
    for (const host of ['cdn.example.com', 'evil.com', 'api.linear.app']) {
      expect(egressAllowed(list, host), host).toBe(false);
    }
    expect(egressAllowed(null, 'anything.example')).toBe(true);
  });
});

describe('destinations', () => {
  const infos = (...addresses: string[]) =>
    addresses.map((address) => ({
      family: address.includes(':') ? (6 as const) : (4 as const),
      address,
    }));

  it('prefers IPv4 among public addresses', () => {
    expect(publicAddress(infos('2606:4700::1', '140.82.112.3'))).toEqual(['140.82.112.3', null]);
  });

  it('refuses the destination when any address is private', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.5.2',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      '0.0.0.0',
      '::ffff:10.0.0.1',
      '::ffff:140.82.112.3',
      '64:ff9b::8c52:7003',
      '2001:db8::1',
      '100::1',
      'fc00::1',
      'ff02::1',
      '240.0.0.1',
      '255.255.255.255',
      '2002::1',
    ]) {
      const [found, reason] = publicAddress(infos('140.82.112.3', address));
      expect(found, address).toBeNull();
      expect(reason).toContain('non-public');
    }
    expect(publicAddress([])[0]).toBeNull();
    expect(publicAddress(infos('not an address'))[1]).toBe('unparsable address');
    for (const address of ['140.82.112.3', '2606:4700::1', '2a00:1450:4001:80e::200e']) {
      expect(publicAddress(infos(address))).toEqual([address, null]);
    }
    expect(publicAddress(infos('fe80::1%en0'))[0]).toBeNull();
  });

  it('refuses the first address of every listed range', () => {
    for (const first of listedRanges()) expect(publicAddress(infos(first))[0], first).toBeNull();
  });
});
