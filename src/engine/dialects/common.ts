// Shared helpers for dialect converters (SPEC 4.5).
import { PPQ } from '../types';
import type { DialectWarning } from './types';

export const WHOLE = PPQ * 4;
export const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];

/** Single length tokens (MML Studio), longest first. */
export const LENGTH_TOKENS: Array<[number, string]> = [
  [1920, '1'],
  [1440, '2.'],
  [960, '2'],
  [720, '4.'],
  [480, '4'],
  [360, '8.'],
  [240, '8'],
  [180, '16.'],
  [120, '16'],
  [90, '32.'],
  [60, '32'],
  [45, '64.'],
  [30, '64'],
];

export function singleToken(ticks: number): string | null {
  for (const [t, s] of LENGTH_TOKENS) if (t === ticks) return s;
  return null;
}

/** Greedy decomposition into length tokens (for `^` ties / consecutive rests). */
export function lengthParts(ticks: number): string[] | null {
  const parts: string[] = [];
  let rest = ticks;
  while (rest > 0) {
    const e = LENGTH_TOKENS.find(([t]) => t <= rest);
    if (!e) return null;
    parts.push(e[1]);
    rest -= e[0];
    if (parts.length > 32) return null;
  }
  return parts;
}

/** `Time(M:B:S)` in fixed 4/4 coordinates. */
export function timeOf(tick: number): string {
  const m = Math.floor(tick / WHOLE) + 1;
  const rest = tick % WHOLE;
  return `Time(${m}:${Math.floor(rest / PPQ) + 1}:${rest % PPQ})`;
}

export function gateOf(duration: number, qPct: number): number {
  let gate = Math.round((duration * qPct) / 100);
  if (qPct > 0 && gate < 1) gate = 1;
  return gate;
}

export class DialectError extends Error {
  constructor(readonly issue: DialectWarning) {
    super(issue.message);
  }
}

export function fail(code: string, message: string, at: { line: number; column: number }): never {
  throw new DialectError({ code, message, line: at.line, column: at.column });
}

/** Warnings aggregated by code + message; the position is the first occurrence. */
export class Warnings {
  private readonly map = new Map<string, DialectWarning>();
  add(code: string, message: string, at: { line: number; column: number }): void {
    const key = `${code}\u0000${message}`;
    const w = this.map.get(key);
    if (w) w.count = (w.count ?? 1) + 1;
    else this.map.set(key, { code, message, line: at.line, column: at.column, count: 1 });
  }
  list(): DialectWarning[] {
    return [...this.map.values()].sort((a, b) => a.line - b.line || a.column - b.column);
  }
}
