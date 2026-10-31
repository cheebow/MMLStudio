// SPEC 8 acceptance tests L01–L26 (PPQ=480, q90, o4c=60).
import { describe, expect, it } from 'vitest';
import { compileMml, ticksToSeconds, type CompiledSong, type NoteEvent, type ProgramEvent } from '../../src/engine';

function ok(src: string): CompiledSong {
  const r = compileMml(src);
  if (!r.ok) throw new Error(`expected success for ${JSON.stringify(src)}: ${r.diagnostics.map((d) => d.message).join(' / ')}`);
  return r.song;
}
function fail(src: string) {
  const r = compileMml(src);
  expect(r.ok, `expected failure for ${JSON.stringify(src)}`).toBe(false);
  return r.diagnostics;
}
function notes(song: CompiledSong, track?: number): NoteEvent[] {
  return song.tracks
    .filter((t) => track === undefined || t.number === track)
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note');
}
const pick = (n: NoteEvent) => ({ pitch: n.pitch, start: n.startTick, dur: n.durationTicks, gate: n.gateTicks, vel: n.velocity, ch: n.channel });

describe('acceptance L01–L26', () => {
  it('L01 o4 c d e', () => {
    const s = ok('o4 c d e');
    expect(notes(s).map(pick)).toEqual([
      { pitch: 60, start: 0, dur: 480, gate: 432, vel: 100, ch: 0 },
      { pitch: 62, start: 480, dur: 480, gate: 432, vel: 100, ch: 0 },
      { pitch: 64, start: 960, dur: 480, gate: 432, vel: 100, ch: 0 },
    ]);
  });

  it('L02 o4 l8 cdef', () => {
    const s = ok('o4 l8 cdef');
    const n = notes(s);
    expect(n).toHaveLength(4);
    expect(n.map((x) => x.durationTicks)).toEqual([240, 240, 240, 240]);
    expect(n.map((x) => x.startTick)).toEqual([0, 240, 480, 720]);
    expect(s.endTick).toBe(960);
  });

  it('L03 o4 c4.', () => {
    const n = notes(ok('o4 c4.'));
    expect(n.map(pick)).toEqual([{ pitch: 60, start: 0, dur: 720, gate: 648, vel: 100, ch: 0 }]);
  });

  it('L04 l8. c r c4', () => {
    const s = ok('l8. c r c4');
    const n = notes(s);
    expect(n.map((x) => [x.startTick, x.durationTicks])).toEqual([
      [0, 360],
      [720, 480],
    ]);
    expect(s.endTick).toBe(1200);
  });

  it('L05 o4 c+ d- f#', () => {
    expect(notes(ok('o4 c+ d- f#')).map((x) => x.pitch)).toEqual([61, 61, 66]);
  });

  it('L06 o4 >c <c', () => {
    expect(notes(ok('o4 >c <c')).map((x) => x.pitch)).toEqual([72, 60]);
  });

  it('L07 v127 q100 c4', () => {
    expect(notes(ok('v127 q100 c4')).map(pick)).toEqual([{ pitch: 60, start: 0, dur: 480, gate: 480, vel: 127, ch: 0 }]);
  });

  it('L08 q0 c4', () => {
    const s = ok('q0 c4');
    expect(notes(s)).toHaveLength(0);
    expect(s.endTick).toBe(480);
  });

  it('L09 c4^8', () => {
    expect(notes(ok('c4^8')).map((x) => [x.pitch, x.durationTicks])).toEqual([[60, 720]]);
  });

  it('L10 c4&c4', () => {
    expect(notes(ok('c4&c4')).map((x) => [x.durationTicks, x.gateTicks])).toEqual([[960, 864]]);
  });

  it('L11 c4&d4 is an error', () => {
    const d = fail('c4&d4');
    expect(d[0].code).toBe('E_TIE_PITCH');
    expect(d[0].span.startColumn).toBe(4);
  });

  it('L12 t120 c4 t60 c4', () => {
    const s = ok('t120 c4 t60 c4');
    expect(s.tempoMap.map((t) => [t.tick, t.bpm, t.microsecondsPerQuarter])).toEqual([
      [0, 120, 500000],
      [480, 60, 1000000],
    ]);
    expect(ticksToSeconds(s.endTick, s.tempoMap)).toBeCloseTo(1.5, 9);
  });

  it('L13 TR(1)c4 TR(2)e8 TR(1)d4', () => {
    const s = ok('TR(1)c4 TR(2)e8 TR(1)d4');
    expect(notes(s, 1).map((x) => [x.pitch, x.startTick])).toEqual([
      [60, 0],
      [62, 480],
    ]);
    expect(notes(s, 2).map((x) => [x.pitch, x.startTick, x.durationTicks])).toEqual([[64, 0, 240]]);
  });

  it('L14 TR(1)CH(1)@1c4 TR(2)CH(2)@49e4', () => {
    const s = ok('TR(1)CH(1)@1c4 TR(2)CH(2)@49e4');
    const programs = s.tracks.flatMap((t) => t.events).filter((e): e is ProgramEvent => e.kind === 'program');
    expect(programs.map((p) => [p.program, p.channel])).toEqual([
      [0, 0],
      [48, 1],
    ]);
    expect(notes(s).map((n) => n.channel)).toEqual([0, 1]);
  });

  it('L15 TR(1) CH(10) n36 n38 n42', () => {
    const n = notes(ok('TR(1) CH(10) n36 n38 n42'));
    expect(n.map((x) => [x.channel, x.pitch, x.startTick])).toEqual([
      [9, 36, 0],
      [9, 38, 480],
      [9, 42, 960],
    ]);
  });

  it('L16 channel sharing is an error', () => {
    const d = fail('TR(1)CH(1)c4 TR(2)CH(1)e4');
    expect(d.map((x) => x.code)).toContain('E_CHANNEL_CONFLICT');
    expect(d[0].span.startColumn).toBe(19);
  });

  it('L17 TR(0)t100 TR(1)c4', () => {
    const s = ok('TR(0)t100 TR(1)c4');
    expect(s.tempoMap.map((t) => [t.tick, t.bpm])).toEqual([[0, 100]]);
    expect(notes(s, 1)).toHaveLength(1);
  });

  it('L18 TR(0)c4 is an error', () => {
    expect(fail('TR(0)c4')[0].code).toBe('E_CONDUCTOR');
  });

  it('L19 TR(1)t120 TR(2)t140 tempo conflict', () => {
    const d = fail('TR(1)t120 TR(2)t140');
    expect(d[0].code).toBe('E_TEMPO_CONFLICT');
    expect(d[0].span.startColumn).toBe(16);
  });

  it('L20 comments', () => {
    const s = ok('// test\no4 c4 /*x*/ d4');
    expect(notes(s).map((x) => [x.pitch, x.startTick])).toEqual([
      [60, 0],
      [62, 480],
    ]);
  });

  it('L21 track state is restored', () => {
    const s = ok('TR(1) o4 c4 TR(2) o5 c4 TR(1) d4');
    expect(notes(s, 1).map((x) => [x.pitch, x.startTick])).toEqual([
      [60, 0],
      [62, 480],
    ]);
    expect(notes(s, 2).map((x) => [x.pitch, x.startTick])).toEqual([[72, 0]]);
  });

  it.each(['@129', 'v128', 'q101', 'o10', 'l3'])('L22 range error %s', (src) => {
    const d = fail(src);
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe('E_RANGE');
    expect(d[0].span.startLine).toBe(1);
  });

  it('L23 c4. c4 r4 end handling', () => {
    const s = ok('c4. c4 r4');
    expect(notes(s).map((x) => [x.startTick, x.durationTicks, x.gateTicks])).toEqual([
      [0, 720, 648],
      [720, 480, 432],
    ]);
    expect(s.endTick).toBe(1680);
  });

  it('L24 TR(10)c4 -> channel 11 (MIDI 10)', () => {
    const s = ok('TR(10)c4');
    expect(s.tracks[0].channel).toBe(10);
    expect(notes(s)[0].channel).toBe(10);
  });

  it('L25 n60', () => {
    expect(notes(ok('n60')).map((x) => [x.pitch, x.durationTicks])).toEqual([[60, 480]]);
  });

  it('L26 c4&c4&c4', () => {
    expect(notes(ok('c4&c4&c4')).map((x) => [x.durationTicks, x.gateTicks])).toEqual([[1440, 1296]]);
  });
});
