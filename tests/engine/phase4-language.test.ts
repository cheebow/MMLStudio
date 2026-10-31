// SPEC 8 Phase 4 acceptance tests L27–L34 and language-extension boundaries (SPEC 3.7).
import { describe, expect, it } from 'vitest';
import { compileMml, writeSmf, type CompiledSong, type ControlEvent, type NoteEvent, type PitchBendEvent } from '../../src/engine';
import { parseSmfForTest } from '../helpers/smf-parse';

function ok(src: string): CompiledSong {
  const r = compileMml(src);
  if (!r.ok) throw new Error(`expected success for ${JSON.stringify(src)}: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join(' / ')}`);
  return r.song;
}
function codes(src: string): string[] {
  const r = compileMml(src);
  return r.ok ? [] : r.diagnostics.map((d) => d.code);
}
const notes = (s: CompiledSong, track?: number) =>
  s.tracks
    .filter((t) => track === undefined || t.number === track)
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note');
const pick = (n: NoteEvent) => [n.pitch, n.startTick, n.durationTicks, n.gateTicks];

describe('acceptance L27–L34', () => {
  it("L27 o4 'ceg'4 d4", () => {
    const s = ok("o4 'ceg'4 d4");
    expect(notes(s).map(pick)).toEqual([
      [60, 0, 480, 432],
      [64, 0, 480, 432],
      [67, 0, 480, 432],
      [62, 480, 480, 432],
    ]);
    expect(s.endTick).toBe(960);
  });

  it("L28 o4 'n60 n64 n67'%300", () => {
    const s = ok("o4 'n60 n64 n67'%300");
    expect(notes(s).map((n) => [n.pitch, n.startTick, n.durationTicks])).toEqual([
      [60, 0, 300],
      [64, 0, 300],
      [67, 0, 300],
    ]);
    expect(s.endTick).toBe(300);
  });

  it('L29 o4 Sub{ c4 e4 } g4', () => {
    const s = ok('o4 Sub{ c4 e4 } g4');
    expect(notes(s).map((n) => [n.pitch, n.startTick])).toEqual([
      [60, 0],
      [67, 0],
      [64, 480],
    ]);
    expect(s.endTick).toBe(960); // the Sub content still counts for the song length
  });

  it('L30 o4 Time(2:2:36)c%123', () => {
    const s = ok('o4 Time(2:2:36)c%123');
    expect(notes(s).map((n) => [n.pitch, n.startTick, n.durationTicks])).toEqual([[60, 2436, 123]]);
  });

  it('L31 TR(0)Time(2:1:0)Tempo(90) TR(1)c4', () => {
    const s = ok('TR(0)Time(2:1:0)Tempo(90) TR(1)c4');
    expect(s.tempoMap.map((t) => [t.tick, t.bpm, t.microsecondsPerQuarter])).toEqual([
      [0, 120, 500000],
      [1920, 90, 666667],
    ]);
    expect(notes(s).map((n) => [n.pitch, n.startTick])).toEqual([[60, 0]]);
  });

  it('L32 o4 q%375 c%480 (independent of q90)', () => {
    const s = ok('o4 q%375 c%480');
    expect(notes(s).map(pick)).toEqual([[60, 0, 480, 375]]);
    // switching back to a percentage
    expect(notes(ok('q%375 c4 q50 c4')).map((n) => n.gateTicks)).toEqual([375, 240]);
  });

  it('L33 CC(64,127) PB(-1024) c4', () => {
    const s = ok('CC(64,127) PB(-1024) c4');
    const ev = s.tracks[0].events;
    const cc = ev.find((e): e is ControlEvent => e.kind === 'cc')!;
    const pb = ev.find((e): e is PitchBendEvent => e.kind === 'pitchbend')!;
    expect([cc.tick, cc.controller, cc.value]).toEqual([0, 64, 127]);
    expect([pb.tick, pb.value]).toEqual([0, -1024]);
    expect(notes(s)[0].startTick).toBe(0);
    // SMF: CC and PB precede the Note On at tick 0; PB is encoded as value+8192 LSB/MSB.
    const midi = parseSmfForTest(writeSmf(s));
    const t1 = midi.tracks[1].filter((e) => e.tick === 0).map((e) => e.type);
    expect(t1).toEqual(['program', 'cc', 'pitchbend', 'noteOn']);
    const pbEv = midi.tracks[1].find((e) => e.type === 'pitchbend')!;
    const raw = pbEv.data[0] | (pbEv.data[1] << 7);
    expect(raw - 8192).toBe(-1024);
  });

  it("L34 TR(1)CH(1) o4 'c>e<g'4 d4", () => {
    const s = ok("TR(1)CH(1) o4 'c>e<g'4 d4");
    expect(notes(s).map((n) => [n.pitch, n.startTick])).toEqual([
      [60, 0],
      [76, 0],
      [67, 0],
      [62, 480],
    ]);
  });
});

describe('chord boundaries', () => {
  it('default length, dotted length, accidentals', () => {
    expect(notes(ok("l8 'c+e'")).map((n) => [n.pitch, n.durationTicks])).toEqual([
      [61, 240],
      [64, 240],
    ]);
    expect(notes(ok("'ceg'8.")).map((n) => n.durationTicks)).toEqual([360, 360, 360]);
  });
  it('shared velocity / gate', () => {
    expect(notes(ok("v80 q50 'ce'4")).map((n) => [n.velocity, n.gateTicks])).toEqual([
      [80, 240],
      [80, 240],
    ]);
  });
  it('errors: single note, duplicate pitch, per-note length, unterminated, foreign command', () => {
    expect(codes("'c'4")).toEqual(['E_CHORD']);
    expect(codes("'c c'4")).toEqual(['E_CHORD']);
    expect(codes("'c n60'4")).toEqual(['E_CHORD']);
    expect(codes("'c4 e'")).toEqual(['E_CHORD']);
    expect(codes("'ce")).toEqual(['E_SYNTAX']);
    expect(codes("'c v10 e'")).toEqual(['E_CHORD']);
    expect(codes("o9 'g>c'")).toEqual(['E_RANGE']);
  });
  it('chord inside the conductor track is an error', () => {
    expect(codes("TR(0) 'ce'")).toEqual(['E_CONDUCTOR']);
  });
});

describe('Sub / Time boundaries', () => {
  it('state changes inside Sub persist outside', () => {
    const s = ok('o4 l4 v100 Sub{ o5 l8 v70 q50 c } r8 c');
    expect(notes(s).map((n) => [n.pitch, n.startTick, n.durationTicks, n.velocity, n.gateTicks])).toEqual([
      [72, 0, 240, 70, 120],
      [72, 240, 240, 70, 120],
    ]);
  });
  it('nested Sub up to 8 levels; 9 is an error', () => {
    const nest = (d: number) => 'Sub{ '.repeat(d) + 'c' + ' }'.repeat(d);
    expect(notes(ok(nest(8)))).toHaveLength(1);
    expect(codes(nest(9))).toEqual(['E_SUB_DEPTH']);
  });
  it('forbidden commands inside Sub', () => {
    expect(codes('Sub{ TR(2) c }')).toEqual(['E_SUB_FORBIDDEN']);
    expect(codes('Sub{ t100 c }')).toEqual(['E_SUB_FORBIDDEN']);
    expect(codes('Sub{ Time(1:1:0) c }')).toEqual(['E_SUB_FORBIDDEN']);
    expect(codes('Sub{ TempoUS(500000) }')).toEqual(['E_SUB_FORBIDDEN']);
    expect(codes('Sub{ CH(2) }')).toEqual(['E_SUB_FORBIDDEN']);
    expect(codes('Sub{ c')).toEqual(['E_SYNTAX']);
    expect(codes('c }')).toEqual(['E_SYNTAX']);
  });
  it('Time ranges and rewind', () => {
    expect(codes('Time(0:1:0)')).toEqual(['E_RANGE']);
    expect(codes('Time(1:5:0)')).toEqual(['E_RANGE']);
    expect(codes('Time(1:1:480)')).toEqual(['E_RANGE']);
    expect(codes('Time(1:1)')).toEqual(['E_MISSING_VALUE']);
    expect(codes('Time(1,1,0)')).toEqual(['E_SYNTAX']);
    const s = ok('Time(2:1:0) c4 Time(1:1:0) d4');
    expect(notes(s).map((n) => [n.pitch, n.startTick])).toEqual([
      [62, 0],
      [60, 1920],
    ]);
    expect(s.endTick).toBe(2400);
  });
  it('Time beyond the tick limit is an error', () => {
    expect(codes('Time(1043:1:0)')).toEqual(['E_LIMIT']);
  });
  it('overlap detection with Sub / Time (same ch + pitch)', () => {
    expect(codes('Sub{ c2 } c4')).toEqual(['E_OVERLAP']);
    expect(codes('q100 Sub{ c4 } r4 c4')).toEqual([]);
    expect(codes('Time(1:1:0) c4 Time(1:1:240) c4')).toEqual(['E_OVERLAP']);
    // q%N may exceed the written length; the overlap rule still applies.
    expect(codes('q%600 c4 c4')).toEqual(['E_OVERLAP']);
    // gate end == next start is fine (Note Off is written before Note On)
    expect(codes('q%480 c4 c4')).toEqual([]);
  });
});

describe('tick lengths, CC, PB, TempoUS', () => {
  it('%N on notes, rests, n, l', () => {
    const s = ok('c%100 r%50 n62%7 l%33 e');
    expect(notes(s).map((n) => [n.pitch, n.startTick, n.durationTicks])).toEqual([
      [60, 0, 100],
      [62, 150, 7],
      [64, 157, 33],
    ]);
  });
  it('%N errors', () => {
    expect(codes('c%0')).toEqual(['E_RANGE']);
    expect(codes('c%2000001')).toEqual(['E_RANGE']);
    expect(codes('c4%10')).toEqual(['E_LENGTH_MIX']);
    expect(codes('c%10.')).toEqual(['E_LENGTH_MIX']);
    expect(codes('c4^%10')).toEqual(['E_LENGTH_MIX']);
    expect(codes('c%')).toEqual(['E_MISSING_VALUE']);
    expect(codes('q%2000001')).toEqual(['E_RANGE']);
    expect(codes('%10')).toEqual(['E_SYNTAX']);
  });
  it('q%0 is silent but advances time', () => {
    const s = ok('q%0 c4 q90 d4');
    expect(notes(s).map((n) => [n.pitch, n.startTick])).toEqual([[62, 480]]);
  });
  it('ties with %N and q%N compute the gate once', () => {
    expect(notes(ok('q%700 c%240&c%240')).map(pick)).toEqual([[60, 0, 480, 700]]);
  });
  it('CC / PB ranges, and they do not advance time', () => {
    expect(codes('CC(128,0)')).toEqual(['E_RANGE']);
    expect(codes('CC(0,128)')).toEqual(['E_RANGE']);
    expect(codes('CC(1)')).toEqual(['E_MISSING_VALUE']);
    expect(codes('PB(8192)')).toEqual(['E_RANGE']);
    expect(codes('PB(-8193)')).toEqual(['E_RANGE']);
    const s = ok('PB(8191) PB(-8192) CC(7,100) c');
    expect(notes(s)[0].startTick).toBe(0);
    expect(s.endTick).toBe(480);
    expect(codes('TR(0) CC(7,100)')).toEqual(['E_CONDUCTOR']);
    expect(codes('TR(16) CC(7,1)')).toEqual(['E_CHANNEL_REQUIRED']);
    expect(codes('TR(1) CC(7,1) CH(2)')).toEqual(['E_CHANNEL_LOCKED']);
  });
  it('TempoUS is written verbatim and conflicts with a different t at the same tick', () => {
    const s = ok('TR(0) TempoUS(500001) TR(1) c');
    expect(s.tempoMap.map((t) => [t.tick, t.microsecondsPerQuarter])).toEqual([[0, 500001]]);
    const midi = parseSmfForTest(writeSmf(s));
    const tempo = midi.tracks[0].find((e) => e.type === 'tempo')!;
    expect((tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2]).toBe(500001);
    expect(codes('TempoUS(500001) t120')).toEqual(['E_TEMPO_CONFLICT']);
    expect(codes('TempoUS(500000) t120')).toEqual([]);
    expect(codes('TempoUS(0)')).toEqual(['E_RANGE']);
    expect(codes('TempoUS(16777216)')).toEqual(['E_RANGE']);
  });
  it('mid-song tempo via TR(0) Time is kept when returning to TR(0)', () => {
    const s = ok('TR(0) Time(2:1:0) TR(1) c TR(0) t90');
    expect(s.tempoMap.map((t) => [t.tick, t.bpm])).toEqual([
      [0, 120],
      [1920, 90],
    ]);
  });
});

describe('SPEC sample 11.5 / 11.6', () => {
  it('11.5 chords and Sub voices compile', () => {
    const s = ok(`TR(0) Time(1:1:0) Tempo(120)
TR(1) CH(1) @1 o4 l4 v100 q100
'ceg'4 'dfa'4
// 同じチャンネルの別声部を重ねる（Sub終了時に演奏位置だけ復帰）
Time(2:1:0) Sub{ v70 c4 e4 g4 } v100 g4`);
    expect(notes(s).map((n) => [n.pitch, n.startTick, n.velocity])).toEqual([
      [60, 0, 100],
      [64, 0, 100],
      [67, 0, 100],
      [62, 480, 100],
      [65, 480, 100],
      [69, 480, 100],
      [60, 1920, 70],
      [67, 1920, 100],
      [64, 2400, 70],
      [67, 2880, 70],
    ]);
  });
  it('11.6 fidelity-style output compiles', () => {
    const s = ok(`// SMF0 import / PPQ480 / pitch, velocity, note-offの一致を優先
TR(0) Time(1:1:0) TempoUS(500000)
TR(1) CH(1) @1
Time(1:1:0) v92 q%360 'n60 n64 n67'%480
Time(1:2:0) CC(64,127)
Time(1:2:0) v85 q%216 n69%240
Time(1:3:0) CC(64,0)`);
    expect(notes(s).map(pick)).toEqual([
      [60, 0, 480, 360],
      [64, 0, 480, 360],
      [67, 0, 480, 360],
      [69, 480, 240, 216],
    ]);
  });
});
