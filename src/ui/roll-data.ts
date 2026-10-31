// Note data for the piano roll (SPEC 6.3): notes in seconds, bar lines, pitch range and lookups.
// Pure functions (no DOM) so they can be tested without a browser.
import { normalizeMidi, readSmf, type CompiledSong, type NoteEvent, type SourceSpan } from '../engine';
import { PPQ } from '../engine/types';

export interface RollNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  /** 0-based MIDI channel */
  channel: number;
  /** index into RollData.tracks (colour) */
  lane: number;
  drum: boolean;
  /** MML position (only for notes compiled from MML) */
  source?: SourceSpan;
}

/** value changes over time (sorted by t) */
export type Steps = Array<{ t: number; v: number }>;

export interface RollTrack {
  label: string;
  channel: number;
  drum: boolean;
  /** program (0..127), CC7 volume, CC11 expression, CC10 pan, pitch bend (-8192..8191) */
  program: Steps;
  volume: Steps;
  expression: Steps;
  pan: Steps;
  bend: Steps;
}

const emptyTimeline = () => ({ program: [] as Steps, volume: [] as Steps, expression: [] as Steps, pan: [] as Steps, bend: [] as Steps });

/** the value in effect at time t (the last change at or before t), or the default */
export function valueAt(steps: Steps, t: number, fallback: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? fallback : steps[found].v;
}

/** adds a program / CC / pitch-bend change to a track timeline */
function addControl(track: RollTrack, t: number, kind: 'program' | 'cc' | 'pitchbend', value: number, controller = -1): void {
  if (kind === 'program') track.program.push({ t, v: value });
  else if (kind === 'pitchbend') track.bend.push({ t, v: value });
  else if (controller === 7) track.volume.push({ t, v: value });
  else if (controller === 11) track.expression.push({ t, v: value });
  else if (controller === 10) track.pan.push({ t, v: value });
}

export interface RollData {
  /** sorted by start */
  notes: RollNote[];
  /** longest note, for the visible-range search */
  maxLength: number;
  /** bar lines in seconds (fixed 4/4, 480 PPQ) */
  bars: number[];
  tracks: RollTrack[];
  /** pitch range of the non-drum notes (null when there are none) */
  low: number | null;
  high: number | null;
  duration: number;
}

const WHOLE = PPQ * 4;
const DRUM_CHANNEL = 9;

/** tick -> seconds for a sorted tempo list ({ tick, microsecondsPerQuarter }) */
export function tickClock(tempos: ReadonlyArray<{ tick: number; microsecondsPerQuarter: number }>): (tick: number) => number {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick);
  const seg: Array<{ tick: number; sec: number; us: number }> = [{ tick: 0, sec: 0, us: 500_000 }];
  for (const t of sorted) {
    const last = seg[seg.length - 1];
    const sec = last.sec + ((t.tick - last.tick) * last.us) / PPQ / 1_000_000;
    if (t.tick === last.tick) seg[seg.length - 1] = { tick: t.tick, sec: last.sec, us: t.microsecondsPerQuarter };
    else seg.push({ tick: t.tick, sec, us: t.microsecondsPerQuarter });
  }
  return (tick: number) => {
    let lo = 0;
    let hi = seg.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (seg[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const s = seg[lo];
    return s.sec + ((tick - s.tick) * s.us) / PPQ / 1_000_000;
  };
}

function finish(notes: RollNote[], tracks: RollTrack[], endTick: number, clock: (t: number) => number): RollData {
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const tr of tracks) for (const s of [tr.program, tr.volume, tr.expression, tr.pan, tr.bend]) s.sort((a, b) => a.t - b.t);
  let low: number | null = null;
  let high: number | null = null;
  let maxLength = 0;
  let duration = 0;
  for (const n of notes) {
    maxLength = Math.max(maxLength, n.end - n.start);
    duration = Math.max(duration, n.end);
    if (n.drum) continue;
    low = low === null ? n.pitch : Math.min(low, n.pitch);
    high = high === null ? n.pitch : Math.max(high, n.pitch);
  }
  const bars: number[] = [];
  for (let t = 0; t <= endTick && bars.length < 10_000; t += WHOLE) bars.push(clock(t));
  return { notes, maxLength, bars, tracks, low, high, duration: Math.max(duration, clock(endTick)) };
}

/** From an MML compile result. One colour lane per MML track. */
export function rollFromSong(song: CompiledSong): RollData {
  const clock = tickClock(song.tempoMap);
  const tracks: RollTrack[] = [];
  const notes: RollNote[] = [];
  for (const t of song.tracks) {
    const lane = tracks.length;
    const track: RollTrack = { label: `TR${t.number}`, channel: t.channel, drum: t.channel === DRUM_CHANNEL, ...emptyTimeline() };
    tracks.push(track);
    for (const e of t.events) {
      if (e.kind === 'program') addControl(track, clock(e.tick), 'program', e.program);
      else if (e.kind === 'cc') addControl(track, clock(e.tick), 'cc', e.value, e.controller);
      else if (e.kind === 'pitchbend') addControl(track, clock(e.tick), 'pitchbend', e.value);
      if (e.kind !== 'note') continue;
      const n = e as NoteEvent;
      if (n.gateTicks <= 0 || n.velocity <= 0) continue;
      notes.push({
        start: clock(n.startTick),
        end: clock(n.startTick + n.gateTicks),
        pitch: n.pitch,
        velocity: n.velocity,
        channel: n.channel,
        lane,
        drum: n.channel === DRUM_CHANNEL,
        source: n.source,
      });
    }
  }
  return finish(notes, tracks, song.endTick, clock);
}

/** From the original MIDI bytes (original-MIDI playback). One colour lane per channel. null when unreadable. */
export function rollFromMidi(bytes: Uint8Array): RollData | null {
  const read = readSmf(bytes);
  if (!read.ok) return null;
  const { song } = normalizeMidi(read.midi);
  const clock = tickClock(song.tempos);
  const tracks: RollTrack[] = [];
  const notes: RollNote[] = [];
  for (const ch of song.channels) {
    if (ch.notes.length === 0) continue;
    const lane = tracks.length;
    const track: RollTrack = { label: `CH${ch.channel + 1}`, channel: ch.channel, drum: ch.channel === DRUM_CHANNEL, ...emptyTimeline() };
    tracks.push(track);
    for (const c of ch.controls) {
      if (c.kind === 'cc') addControl(track, clock(c.tick), 'cc', c.value, c.controller);
      else addControl(track, clock(c.tick), c.kind, c.kind === 'program' ? c.program : c.value);
    }
    for (const n of ch.notes) {
      notes.push({ start: clock(n.startTick), end: clock(n.endTick), pitch: n.pitch, velocity: n.velocity, channel: n.channel, lane, drum: n.channel === DRUM_CHANNEL });
    }
  }
  return finish(notes, tracks, song.endTick, clock);
}

/** index of the first note that may still sound at time t (notes sorted by start) */
function firstFrom(data: RollData, t: number): number {
  const from = t - data.maxLength;
  let lo = 0;
  let hi = data.notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data.notes[mid].start < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** notes overlapping [t0, t1) */
export function notesBetween(data: RollData, t0: number, t1: number): RollNote[] {
  const out: RollNote[] = [];
  for (let i = firstFrom(data, t0); i < data.notes.length; i++) {
    const n = data.notes[i];
    if (n.start >= t1) break;
    if (n.end > t0) out.push(n);
  }
  return out;
}

/** meter level 0..1 of a lane at time t: the loudest note-on in the last 0.6 s, decaying */
export function levelAt(data: RollData, lane: number, t: number): number {
  let level = 0;
  for (const n of notesBetween(data, t - 0.6, t + 1e-9)) {
    if (n.lane !== lane || n.start > t) continue;
    const age = t - n.start;
    if (age < 0.6) level = Math.max(level, (n.velocity / 127) * (1 - age / 0.6));
  }
  return level;
}

/** notes sounding at time t */
export function notesAt(data: RollData, t: number): RollNote[] {
  return notesBetween(data, t, t + 1e-9).filter((n) => n.start <= t && t < n.end);
}

/** pitch range to show: the used range with a margin, at least two octaves */
export function pitchWindow(data: RollData): { low: number; high: number } {
  if (data.low === null || data.high === null) return { low: 48, high: 84 };
  let low = data.low - 2;
  let high = data.high + 2;
  if (high - low < 24) {
    const mid = Math.round((low + high) / 2);
    low = mid - 12;
    high = mid + 12;
  }
  return { low: Math.max(0, low), high: Math.min(127, high) };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** `C4` = MIDI 60 (MML Studio o4c) */
export function pitchName(pitch: number): string {
  return `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
export const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
