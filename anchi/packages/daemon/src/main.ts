import { homeLayout } from '@anchi/core';
import { Daemon } from './daemon.ts';

const daemon = new Daemon({ layout: homeLayout() });
try {
  await daemon.start();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void daemon.stop().then(() => process.exit(0));
  });
}
