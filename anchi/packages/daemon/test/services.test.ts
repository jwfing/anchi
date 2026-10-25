import { describe, expect, it, vi } from 'vitest';
import { Guest, type ExecResult, type GuestTransport } from '../src/guest.ts';
import { ServiceSetup } from '../src/services.ts';

function fakeGuest(answers: (args: string[], stdin: string) => unknown) {
  const execs: { args: string[]; stdin: string }[] = [];
  const transport = {
    exec: async (args: string[], stdin = ''): Promise<ExecResult> => {
      execs.push({ args, stdin });
      const v = answers(args, stdin);
      return { code: 0, stdout: JSON.stringify(v, null, 2), stderr: '' };
    },
    spawn: () => {
      throw new Error('unused');
    },
  } as unknown as GuestTransport;
  return { guest: new Guest(transport), execs };
}

describe('service connectors', () => {
  it('signs in to X on the registered callback, rejects forged callbacks and sends the code on stdin', async () => {
    const { guest, execs } = fakeGuest((args) =>
      args[2] === 'begin'
        ? { url: 'https://x.com/i/oauth2/authorize?test', state: 'expected' }
        : { connected: true },
    );
    const results: unknown[] = [];
    const s = new ServiceSetup(
      guest,
      (r) => results.push(r),
      () => {},
    );
    try {
      await s.setXClient('test-client');
      const imported = execs.at(-1)!;
      expect(imported.args.slice(-2)).toEqual(['import-client', 'x']);
      expect(JSON.parse(imported.stdin)).toEqual({ client_id: 'test-client' });
      await s.setMode('x', 'auto');
      expect(execs.at(-1)!.args.slice(-3)).toEqual(['mode', 'x', 'auto']);
      expect(await s.xLogin()).toContain('https://x.com/');
      const redirect = JSON.parse(execs.find((e) => e.args[2] === 'begin')!.stdin).redirect_uri;
      expect(redirect).toBe('http://127.0.0.1:48173/callback');
      for (const query of [
        'state=wrong&code=c',
        'state=expecté&code=c',
        'state=expected&state=expected&code=c',
      ]) {
        expect((await fetch(`${redirect}?${query}`)).status).toBe(400);
      }
      expect((await fetch(`${redirect}?state=expected&code=c`, { method: 'POST' })).status).toBe(
        400,
      );
      expect(execs.some((e) => e.args[2] === 'complete')).toBe(false);
      expect((await fetch(`${redirect}?state=expected&code=test-code`)).status).toBe(200);
      await vi.waitFor(() => expect(results).toEqual([{ id: 'x', ok: true }]));
      const completed = execs.find((e) => e.args[2] === 'complete')!;
      expect(completed.args.slice(-2)).toEqual(['complete', 'x']);
      expect(JSON.parse(completed.stdin)).toEqual({ code: 'test-code', state: 'expected' });
      expect(completed.args.join(' ')).not.toContain('test-code');
    } finally {
      s.stop();
    }
  });

  it('reports X client, account, reauthorization and pending revocation without secrets', async () => {
    const { guest } = fakeGuest((args) =>
      args[1]!.endsWith('policy_admin.py')
        ? { rules: { x: 'auto' } }
        : {
            x: {
              connected: true,
              account: '@example',
              client_configured: true,
              reauth_required: true,
              revocation_pending: true,
            },
          },
    );
    const status = await new ServiceSetup(guest).status();
    expect(status.xClient).toBe(true);
    expect(status.services.find((s) => s.id === 'x')).toMatchObject({
      connected: true,
      account: '@example',
      reauthRequired: true,
      revocationPending: true,
      mode: 'auto',
    });
    // Without a rule from the policy service, publishing asks.
    const unknown = fakeGuest((args) => (args[1]!.endsWith('policy_admin.py') ? {} : {}));
    const fallback = await new ServiceSetup(unknown.guest).status();
    expect(fallback.services.find((s) => s.id === 'x')!.mode).toBe('ask');
    expect(fallback.services.find((s) => s.id === 'notion')!.mode).toBe('auto');
  });
  it('signs in to Reddit on the registered callback, rejects forged callbacks and sends the code on stdin', async () => {
    const { guest, execs } = fakeGuest((args) =>
      args[2] === 'begin'
        ? { url: 'https://www.reddit.com/api/v1/authorize?test', state: 'expected' }
        : { connected: true },
    );
    const results: unknown[] = [];
    const s = new ServiceSetup(
      guest,
      (r) => results.push(r),
      () => {},
    );
    try {
      await s.setRedditClient('test-client', 'developer');
      const imported = execs.at(-1)!;
      expect(imported.args.slice(-2)).toEqual(['import-client', 'reddit']);
      expect(JSON.parse(imported.stdin)).toEqual({
        client_id: 'test-client',
        developer_username: 'developer',
      });
      await s.setMode('reddit', 'auto');
      expect(execs.at(-1)!.args.slice(-3)).toEqual(['mode', 'reddit', 'auto']);
      expect(await s.redditLogin()).toContain('https://www.reddit.com/');
      const redirect = JSON.parse(execs.find((e) => e.args[2] === 'begin')!.stdin).redirect_uri;
      expect(redirect).toBe('http://127.0.0.1:48174/callback');
      for (const query of [
        'state=wrong&code=c',
        'state=expecté&code=c',
        'state=expected&state=expected&code=c',
      ]) {
        expect((await fetch(`${redirect}?${query}`)).status).toBe(400);
      }
      expect((await fetch(`${redirect}?state=expected&code=c`, { method: 'POST' })).status).toBe(
        400,
      );
      expect(execs.some((e) => e.args[2] === 'complete')).toBe(false);
      expect((await fetch(`${redirect}?state=expected&code=test-code`)).status).toBe(200);
      await vi.waitFor(() => expect(results).toEqual([{ id: 'reddit', ok: true }]));
      const completed = execs.find((e) => e.args[2] === 'complete')!;
      expect(completed.args.slice(-2)).toEqual(['complete', 'reddit']);
      expect(JSON.parse(completed.stdin)).toEqual({ code: 'test-code', state: 'expected' });
      expect(completed.args.join(' ')).not.toContain('test-code');
    } finally {
      s.stop();
    }
  });

  it('reports Reddit client, account, reauthorization and pending revocation without secrets', async () => {
    const { guest } = fakeGuest((args) =>
      args[1]!.endsWith('policy_admin.py')
        ? { rules: { reddit: 'auto' } }
        : {
            reddit: {
              connected: true,
              account: 'u/example',
              client_configured: true,
              reauth_required: true,
              revocation_pending: true,
            },
          },
    );
    const status = await new ServiceSetup(guest).status();
    expect(status.redditClient).toBe(true);
    expect(status.services.find((s) => s.id === 'reddit')).toMatchObject({
      connected: true,
      account: 'u/example',
      reauthRequired: true,
      revocationPending: true,
      mode: 'auto',
    });
    // Without a rule from the policy service, publishing asks.
    const unknown = fakeGuest((args) => (args[1]!.endsWith('policy_admin.py') ? {} : {}));
    const fallback = await new ServiceSetup(unknown.guest).status();
    expect(fallback.services.find((s) => s.id === 'reddit')!.mode).toBe('ask');
    expect(fallback.services.find((s) => s.id === 'notion')!.mode).toBe('auto');
  });
  it('reports status and modes, and keeps tokens off the Google connectors', async () => {
    const { guest } = fakeGuest((args) =>
      args[1]!.endsWith('policy_admin.py')
        ? { rules: { notion: 'ask' } }
        : {
            gmail: { connected: true, reauth_required: true },
            notion: { connected: true, account: 'me' },
            client_configured: true,
          },
    );
    const s = new ServiceSetup(guest);
    const st = await s.status();
    expect(st.googleClient).toBe(true);
    expect(st.services.find((x) => x.id === 'gmail')).toMatchObject({
      connected: true,
      reauthRequired: true,
      mode: 'auto',
    });
    expect(st.services.find((x) => x.id === 'notion')).toMatchObject({
      account: 'me',
      mode: 'ask',
    });
    await expect(s.setToken('gmail', 'x')).rejects.toThrow(/Google sign-in/);
  });

  it('signs in to Google through a loopback callback with the VM state', async () => {
    let redirect = '';
    const { guest, execs } = fakeGuest((args, stdin) => {
      if (args[2] === 'begin') {
        redirect = JSON.parse(stdin).redirect_uri;
        return { url: 'https://accounts.google.com/o/oauth2/auth?x', state: 'expected-state' };
      }
      return { connected: true };
    });
    const results: unknown[] = [];
    const opened: string[] = [];
    const s = new ServiceSetup(
      guest,
      (r) => results.push(r),
      (u) => opened.push(u),
    );
    const url = await s.googleLogin('drive');
    expect(url).toContain('accounts.google.com');
    expect(opened).toEqual([url]);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await fetch(`${redirect}?state=wrong&code=c`)).status).toBe(400);
    const port = new URL(redirect).port;
    expect(
      (await fetch(`http://localhost:${port}/callback?state=expected-state&code=c`)).status,
    ).toBe(400); // Host header must be 127.0.0.1:<port>
    expect((await fetch(`${redirect}?state=expected-state&code=the-code`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const complete = execs.find((e) => e.args[2] === 'complete')!;
    expect(complete.args.slice(1)).toEqual([
      '/opt/secure-vm/services/admin.py',
      'complete',
      'drive',
    ]);
    expect(JSON.parse(complete.stdin)).toEqual({ code: 'the-code', state: 'expected-state' });
    expect(results).toEqual([{ id: 'drive', ok: true }]);
    await expect(s.googleLogin('notion')).rejects.toThrow(/Google sign-in/);
  });

  it('says nothing for a sign-in replaced by a newer attempt for the same account', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let redirect = '';
      const { guest } = fakeGuest((args, stdin) => {
        if (args[2] === 'begin') {
          redirect = JSON.parse(stdin).redirect_uri;
          return { url: 'https://accounts.google.com/o/oauth2/auth?x', state: 'st' };
        }
        return { connected: true };
      });
      const results: unknown[] = [];
      const s = new ServiceSetup(
        guest,
        (r) => results.push(r),
        () => {},
      );
      await s.googleLogin('gmail', 'work');
      const first = redirect;
      await s.googleLogin('gmail', 'work');
      expect(redirect).not.toBe(first);
      expect((await fetch(`${redirect}?state=st&code=c`)).status).toBe(200);
      await vi.waitFor(() => expect(results).toEqual([{ id: 'gmail', account: 'work', ok: true }]));
      // Past the first attempt's timeout: it was replaced, so it must not report a failure.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(results).toEqual([{ id: 'gmail', account: 'work', ok: true }]);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still times out the attempt that replaced an earlier one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { guest } = fakeGuest((args) =>
        args[2] === 'begin'
          ? { url: 'https://accounts.google.com/o/oauth2/auth?x', state: 'st' }
          : { connected: true },
      );
      const results: unknown[] = [];
      const s = new ServiceSetup(
        guest,
        (r) => results.push(r),
        () => {},
      );
      await s.googleLogin('drive');
      await s.googleLogin('drive');
      await vi.advanceTimersByTimeAsync(600_000);
      // One timeout for the live attempt, none for the replaced one.
      expect(results).toEqual([
        { id: 'drive', ok: false, error: 'sign-in cancelled or timed out' },
      ]);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists Google accounts, reports the client source and names accounts in VM commands', async () => {
    let redirect = '';
    const { guest, execs } = fakeGuest((args, stdin) => {
      if (args[1]!.endsWith('policy_admin.py')) return { rules: {} };
      if (args[2] === 'begin') {
        redirect = JSON.parse(stdin).redirect_uri;
        return { url: 'https://accounts.google.com/o/oauth2/auth?x', state: 'st' };
      }
      return {
        gmail: {
          connected: true,
          account: 'me@home.test',
          accounts: [
            { name: 'default', connected: true, account: 'me@home.test' },
            { name: 'work', connected: false, revocation_pending: true },
          ],
        },
        client_configured: true,
        client_source: 'builtin',
      };
    });
    const results: unknown[] = [];
    const s = new ServiceSetup(
      guest,
      (r) => results.push(r),
      () => {},
    );
    const st = await s.status();
    expect(st.googleClientSource).toBe('builtin');
    expect(st.services.find((x) => x.id === 'gmail')!.accounts).toEqual([
      {
        name: 'default',
        connected: true,
        account: 'me@home.test',
        reauthRequired: false,
        revocationPending: false,
      },
      {
        name: 'work',
        connected: false,
        account: null,
        reauthRequired: false,
        revocationPending: true,
      },
    ]);
    expect(st.services.find((x) => x.id === 'notion')!.accounts).toEqual([]);
    await s.googleLogin('gmail', 'work');
    expect(execs.find((e) => e.args[2] === 'begin')!.args.slice(2)).toEqual([
      'begin',
      'gmail',
      'work',
    ]);
    expect((await fetch(`${redirect}?state=st&code=c`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(execs.find((e) => e.args[2] === 'complete')!.args.slice(2)).toEqual([
      'complete',
      'gmail',
      'work',
    ]);
    expect(execs.find((e) => e.args[3] === 'probe')!.args.slice(1)).toEqual([
      '/opt/secure-vm/services/connector_admin.py',
      'gmail',
      'probe',
      'work',
    ]);
    expect(results).toEqual([{ id: 'gmail', account: 'work', ok: true }]);
    await s.disconnect('drive', 'personal');
    expect(execs.at(-1)!.args.slice(2)).toEqual(['drive', 'disconnect', 'personal']);
    await s.removeGoogleClient();
    expect(execs.at(-1)!.args.slice(2)).toEqual(['remove-client']);
    await expect(s.googleLogin('gmail', 'Work')).rejects.toThrow(/account names/);
    await expect(s.disconnect('notion', 'work')).rejects.toThrow(/no named accounts/);
  });
});
