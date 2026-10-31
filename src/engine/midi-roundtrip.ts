// Compare expected canonical MIDI events with a recompiled MML song (SPEC 4.4.3 A-5).
import { DEFAULT_US_PER_QUARTER } from './compiler';
import type { CanonControl, CanonNote, CanonSong, CanonTempo, RoundTripReport } from './midi-types';
import type { CompiledSong } from './types';

const MAX_MESSAGES = 20;
const DRUM_CHANNEL = 9;

/** Canonical events of a compiled MML song (Note Off = start + gate). */
export function canonFromCompiled(song: CompiledSong): CanonSong {
  const byChannel = new Map<number, { notes: CanonNote[]; controls: CanonControl[]; tracks: number[] }>();
  for (const t of song.tracks) {
    let entry = byChannel.get(t.channel);
    if (!entry) byChannel.set(t.channel, (entry = { notes: [], controls: [], tracks: [] }));
    entry.tracks.push(t.number);
    for (const e of t.events) {
      switch (e.kind) {
        case 'note':
          entry.notes.push({ channel: e.channel, pitch: e.pitch, velocity: e.velocity, startTick: e.startTick, endTick: e.startTick + e.gateTicks });
          break;
        case 'program':
          entry.controls.push({ kind: 'program', channel: e.channel, tick: e.tick, program: e.program });
          break;
        case 'cc':
          entry.controls.push({ kind: 'cc', channel: e.channel, tick: e.tick, controller: e.controller, value: e.value });
          break;
        case 'pitchbend':
          entry.controls.push({ kind: 'pitchbend', channel: e.channel, tick: e.tick, value: e.value });
          break;
      }
    }
  }
  return {
    channels: [...byChannel.entries()].sort((a, b) => a[0] - b[0]).map(([channel, v]) => ({ channel, notes: v.notes, controls: v.controls, sourceTracks: v.tracks })),
    tempos: song.tempoMap.map((t) => ({ tick: t.tick, microsecondsPerQuarter: t.microsecondsPerQuarter })),
    endTick: song.endTick,
  };
}

/** Semantic initial state: tempo 120 BPM at tick 0 and GM Piano (program 0) at tick 0 are implicit. */
function normalizeTempos(tempos: CanonTempo[]): CanonTempo[] {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick);
  if (!sorted.some((t) => t.tick === 0)) sorted.unshift({ tick: 0, microsecondsPerQuarter: DEFAULT_US_PER_QUARTER });
  return sorted;
}

function normalizeControls(channel: number, controls: CanonControl[]): CanonControl[] {
  // stable sort by tick (relative order inside a tick is kept)
  const sorted = controls.map((c, i) => ({ c, i })).sort((a, b) => a.c.tick - b.c.tick || a.i - b.i).map((x) => x.c);
  if (channel === DRUM_CHANNEL) return sorted;
  const programsAtZero = sorted.filter((c) => c.kind === 'program' && c.tick === 0);
  if (programsAtZero.length === 1 && programsAtZero[0].kind === 'program' && programsAtZero[0].program === 0) {
    return sorted.filter((c) => c !== programsAtZero[0]);
  }
  return sorted;
}

const noteKey = (n: CanonNote) => `ch${n.channel + 1} pitch ${n.pitch} vel ${n.velocity} on ${n.startTick} off ${n.endTick}`;

function controlKey(c: CanonControl): string {
  switch (c.kind) {
    case 'program':
      return `ch${c.channel + 1} tick ${c.tick} Program ${c.program}`;
    case 'cc':
      return `ch${c.channel + 1} tick ${c.tick} CC${c.controller}=${c.value}`;
    case 'pitchbend':
      return `ch${c.channel + 1} tick ${c.tick} PB ${c.value}`;
  }
}

/**
 * Compares the expected (normalised MIDI) events with the events of a compiled MML song.
 * Notes are compared as multisets (pitch / channel / velocity / on tick / off tick);
 * Program / CC / PB per channel and kind in time order; tempo by tick and exact μs value.
 */
export function compareMidiEvents(expected: CanonSong, compiled: CompiledSong): RoundTripReport {
  const actual = canonFromCompiled(compiled);
  const mismatches: string[] = [];
  let mismatchCount = 0;
  const report = (msg: string) => {
    mismatchCount++;
    if (mismatches.length < MAX_MESSAGES) mismatches.push(msg);
  };

  // Notes (multiset)
  const expNotes = expected.channels.flatMap((c) => c.notes);
  const actNotes = actual.channels.flatMap((c) => c.notes);
  const counts = new Map<string, number>();
  for (const n of expNotes) counts.set(noteKey(n), (counts.get(noteKey(n)) ?? 0) + 1);
  for (const n of actNotes) counts.set(noteKey(n), (counts.get(noteKey(n)) ?? 0) - 1);
  for (const [k, v] of counts) {
    if (v > 0) for (let i = 0; i < v; i++) report(`MML に無いノート: ${k}`);
    if (v < 0) for (let i = 0; i < -v; i++) report(`元 MIDI に無いノート: ${k}`);
  }

  // Controls
  const channels = new Set([...expected.channels.map((c) => c.channel), ...actual.channels.map((c) => c.channel)]);
  let programs = 0;
  let cc = 0;
  let pitchbend = 0;
  for (const ch of [...channels].sort((a, b) => a - b)) {
    const exp = normalizeControls(ch, expected.channels.find((c) => c.channel === ch)?.controls ?? []);
    const act = normalizeControls(ch, actual.channels.find((c) => c.channel === ch)?.controls ?? []);
    for (const kind of ['program', 'cc', 'pitchbend'] as const) {
      const e = exp.filter((c) => c.kind === kind);
      const a = act.filter((c) => c.kind === kind);
      if (kind === 'program') programs += e.length;
      else if (kind === 'cc') cc += e.length;
      else pitchbend += e.length;
      const len = Math.max(e.length, a.length);
      for (let i = 0; i < len; i++) {
        const ek = e[i] ? controlKey(e[i]) : null;
        const ak = a[i] ? controlKey(a[i]) : null;
        if (ek !== ak) report(`${kind === 'cc' ? 'CC' : kind === 'program' ? 'Program' : 'Pitch Bend'} 不一致: 元 ${ek ?? '（なし）'} / MML ${ak ?? '（なし）'}`);
      }
    }
  }

  // Tempo
  const et = normalizeTempos(expected.tempos);
  const at = normalizeTempos(actual.tempos);
  for (let i = 0; i < Math.max(et.length, at.length); i++) {
    const e = et[i];
    const a = at[i];
    if (!e || !a || e.tick !== a.tick || e.microsecondsPerQuarter !== a.microsecondsPerQuarter) {
      report(`テンポ不一致: 元 ${e ? `tick ${e.tick} ${e.microsecondsPerQuarter}μs` : '（なし）'} / MML ${a ? `tick ${a.tick} ${a.microsecondsPerQuarter}μs` : '（なし）'}`);
    }
  }

  return {
    ok: mismatchCount === 0,
    compared: { notes: expNotes.length, tempos: et.length, programs, cc, pitchbend },
    mismatchCount,
    mismatches,
  };
}
