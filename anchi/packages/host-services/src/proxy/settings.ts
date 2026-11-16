import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HIGH_RISK_IDS } from '../rules/table.ts';
import { APPROVAL_TIMEOUT } from './approvals.ts';

export interface EgressSettings {
  high_risk_disabled: string[];
  approval_timeout_s: number;
}

const TIMEOUT_MIN = 60;
const TIMEOUT_MAX = 43_200;

/** The daemon's settings, validated: unknown high-risk ids or a timeout out of bounds are errors. */
export function checkSettings(value: unknown): EgressSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_SETTINGS');
  const { high_risk_disabled: disabled = [], approval_timeout_s: timeout = APPROVAL_TIMEOUT } =
    value as {
      high_risk_disabled?: unknown;
      approval_timeout_s?: unknown;
    };
  if (
    !Array.isArray(disabled) ||
    !disabled.every((d) => typeof d === 'string' && HIGH_RISK_IDS.includes(d))
  )
    throw new Error('BAD_SETTINGS');
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < TIMEOUT_MIN ||
    timeout > TIMEOUT_MAX
  )
    throw new Error('BAD_SETTINGS');
  return {
    high_risk_disabled: [...new Set(disabled as string[])].sort(),
    approval_timeout_s: timeout,
  };
}

export function loadSettings(file: string): EgressSettings {
  try {
    return checkSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { high_risk_disabled: [], approval_timeout_s: APPROVAL_TIMEOUT };
  }
}

export function saveSettings(file: string, settings: EgressSettings): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.new`, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
  renameSync(`${file}.new`, file);
}
