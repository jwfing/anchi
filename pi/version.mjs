import { createRequire } from 'node:module';
// The installed package manifest is the authoritative Pi version; guest/cell.env must match (tested).
export const PI_VERSION = createRequire(import.meta.url)('./package.json').dependencies[
  '@earendil-works/pi-coding-agent'
];
