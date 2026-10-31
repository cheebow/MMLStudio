// GM names live in the engine (pure data); re-exported for the UI.
import { GM_INSTRUMENTS } from '../engine/gm-instruments';

export { GM_INSTRUMENTS };

export const DRUM_CHANNEL_INDEX = 9;

export function instrumentName(program: number): string {
  return GM_INSTRUMENTS[program] ?? `Program ${program}`;
}
