import { describe, expect, it } from 'vitest';
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
});
