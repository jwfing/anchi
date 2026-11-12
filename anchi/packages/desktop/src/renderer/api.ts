import type { MethodName, Params, Result } from '@anchi/protocol';
import type { AnchiApi } from '../shared.ts';

// The views take the window's types from here, one level up, not from outside the renderer.
export type { ReleaseUpdate, ServerState } from '../shared.ts';

declare global {
  interface Window {
    anchi: AnchiApi;
  }
}

/** A typed daemon call through the main process (which checks the method against its list). */
export function machineCall(server: string) {
  return <M extends MethodName>(
    method: M,
    ...params: Params<M> extends Record<string, never> ? [] : [Params<M>]
  ): Promise<Result<M>> => window.anchi.call(server, method, params[0] ?? {}) as Promise<Result<M>>;
}

export type Call = ReturnType<typeof machineCall>;

/** Every stored event of a task, page by page. */
export async function allEvents(call: Call, taskId: string) {
  const out: Awaited<Result<'tasks.events'>> = [];
  let afterSeq = 0;
  for (;;) {
    const page = await call('tasks.events', { taskId, afterSeq });
    if (!page.length) return out;
    out.push(...page);
    afterSeq = page.at(-1)!.seq;
  }
}

/** Electron prefixes errors from the main process; the daemon's own message is what matters. */
export function message(err: unknown): string {
  const text = String((err as Error)?.message ?? err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
  // The daemon passes on what the VM tool printed, which tells the reader to run a command.
  if (text.startsWith('GUEST_UNAVAILABLE')) {
    return 'The secure room is not running, so this cannot be read or changed now. Start it from Needs you.';
  }
  return text;
}
