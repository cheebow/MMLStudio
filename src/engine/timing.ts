// Tick <-> seconds conversion via piecewise integration over the tempo map (SPEC 4.3).
import { PPQ, type TempoEvent } from './types';

const DEFAULT_US = 500_000;

function sorted(tempoMap: readonly TempoEvent[]): TempoEvent[] {
  return [...tempoMap].sort((a, b) => a.tick - b.tick);
}

export function ticksToSeconds(tick: number, tempoMap: readonly TempoEvent[], ppq: number = PPQ): number {
  let seconds = 0;
  let lastTick = 0;
  let us = DEFAULT_US;
  for (const t of sorted(tempoMap)) {
    if (t.tick >= tick) break;
    seconds += ((t.tick - lastTick) * us) / ppq / 1_000_000;
    lastTick = t.tick;
    us = t.microsecondsPerQuarter;
  }
  return seconds + ((tick - lastTick) * us) / ppq / 1_000_000;
}

export function secondsToTicks(seconds: number, tempoMap: readonly TempoEvent[], ppq: number = PPQ): number {
  let elapsed = 0;
  let lastTick = 0;
  let us = DEFAULT_US;
  for (const t of sorted(tempoMap)) {
    const segment = ((t.tick - lastTick) * us) / ppq / 1_000_000;
    if (elapsed + segment > seconds) break;
    elapsed += segment;
    lastTick = t.tick;
    us = t.microsecondsPerQuarter;
  }
  return lastTick + ((seconds - elapsed) * 1_000_000 * ppq) / us;
}
