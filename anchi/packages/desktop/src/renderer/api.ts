import type { MethodName, Params, Result } from '@anchi/protocol';
import type { AnchiApi } from '../shared.ts';

declare global {
  interface Window {
    anchi: AnchiApi;
  }
}

/** A typed daemon call through the main process (which checks the method against its list). */
export function call<M extends MethodName>(
  method: M,
  ...params: Params<M> extends Record<string, never> ? [] : [Params<M>]
): Promise<Result<M>> {
  return window.anchi.call(method, params[0] ?? {}) as Promise<Result<M>>;
}

/** Every stored event of a task, page by page. */
export async function allEvents(taskId: string) {
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
  return String((err as Error)?.message ?? err).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}
