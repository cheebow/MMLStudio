// SMF round-trip through the independent test parser (SPEC 4.2, 8 "追加" 1).
import { describe, expect, it } from 'vitest';
import { compileMml, encodeVlq, writeSmf, type CompiledSong } from '../../src/engine';
import { parseSmfForTest } from '../helpers/smf-parse';

function song(src: string): CompiledSong {
  const r = compileMml(src);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('\n'));
  return r.song;
}

const SAMPLE_3TRACK = `// 全体のテンポ
TR(0) Tempo(120)

// Piano
TR(1) CH(1) @1
 o4 l4 v105 q90
 c e g >c

// Strings
TR(2) CH(2) @49
 o3 l2 v80 q100
 c g

// Drums (GM channel 10)
TR(3) CH(10)
 l8 v110 q90
 n36 n42 n38 n42 n36 n42 n38 n42
`;

describe('VLQ', () => {
  it.each([
    [0, [0x00]],
    [0x40, [0x40]],
    [0x7f, [0x7f]],
    [0x80, [0x81, 0x00]],
    [0x2000, [0xc0, 0x00]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x81, 0x80, 0x00]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ])('%i', (v, bytes) => {
    expect(encodeVlq(v)).toEqual(bytes);
  });
});

describe('writeSmf', () => {
  it('3-track sample: header, tracks, programs, notes, tempo, EOT', () => {
    const s = song(SAMPLE_3TRACK);
    const midi = parseSmfForTest(writeSmf(s));
    expect(midi.format).toBe(1);
    expect(midi.division).toBe(480);
    expect(midi.ntrks).toBe(4);

    const [conductor, piano, strings, drums] = midi.tracks;
    expect(conductor.filter((e) => e.type === 'tempo').map((e) => [e.tick, e.data])).toEqual([[0, [0x07, 0xa1, 0x20]]]);
    expect(conductor.find((e) => e.type === 'timeSig')?.data).toEqual([4, 2, 24, 8]);
    for (const t of midi.tracks) {
      const last = t[t.length - 1];
      expect(last.type).toBe('eot');
      expect(last.tick).toBe(1920);
      expect(t.filter((e) => e.type === 'eot')).toHaveLength(1);
    }

    expect(piano.filter((e) => e.type === 'program').map((e) => [e.tick, e.channel, e.data[0]])).toEqual([[0, 0, 0]]);
    expect(strings.filter((e) => e.type === 'program').map((e) => [e.tick, e.channel, e.data[0]])).toEqual([[0, 1, 48]]);
    expect(drums.filter((e) => e.type === 'program')).toEqual([]); // no PC on drum channel

    expect(piano.filter((e) => e.type === 'noteOn').map((e) => [e.tick, e.data[0], e.data[1]])).toEqual([
      [0, 60, 105],
      [480, 64, 105],
      [960, 67, 105],
      [1440, 72, 105],
    ]);
    expect(piano.filter((e) => e.type === 'noteOff').map((e) => [e.tick, e.data[0]])).toEqual([
      [432, 60],
      [912, 64],
      [1392, 67],
      [1872, 72],
    ]);
    expect(strings.filter((e) => e.type === 'noteOff').map((e) => e.tick)).toEqual([960, 1920]);
    expect(drums.filter((e) => e.type === 'noteOn').map((e) => [e.tick, e.channel, e.data[0]])).toEqual([
      [0, 9, 36],
      [240, 9, 42],
      [480, 9, 38],
      [720, 9, 42],
      [960, 9, 36],
      [1200, 9, 42],
      [1440, 9, 38],
      [1680, 9, 42],
    ]);
  });

  it('implicit program 0 is written for tracks without @', () => {
    const midi = parseSmfForTest(writeSmf(song('c')));
    expect(midi.tracks[1].filter((e) => e.type === 'program').map((e) => [e.tick, e.data[0]])).toEqual([[0, 0]]);
  });

  it('program change mid-track keeps an initial PC0 at tick 0', () => {
    const midi = parseSmfForTest(writeSmf(song('c @41 d')));
    expect(midi.tracks[1].filter((e) => e.type === 'program').map((e) => [e.tick, e.data[0]])).toEqual([
      [0, 0],
      [480, 40],
    ]);
  });

  it('same tick ordering: Note Off -> Program -> Note On', () => {
    const midi = parseSmfForTest(writeSmf(song('q100 c4 @2 c4')));
    const at480 = midi.tracks[1].filter((e) => e.tick === 480).map((e) => e.type);
    expect(at480).toEqual(['noteOff', 'program', 'noteOn']);
  });

  it('tempo changes are written with exact μs', () => {
    const midi = parseSmfForTest(writeSmf(song('t120 c4 t60 c4 t90 c4')));
    expect(midi.tracks[0].filter((e) => e.type === 'tempo').map((e) => [e.tick, (e.data[0] << 16) | (e.data[1] << 8) | e.data[2]])).toEqual([
      [0, 500000],
      [480, 1000000],
      [960, 666667],
    ]);
  });

  it('EOT includes trailing rests', () => {
    const midi = parseSmfForTest(writeSmf(song('c4 r1')));
    expect(midi.tracks[1].at(-1)).toMatchObject({ type: 'eot', tick: 2400 });
  });

  it('empty song still produces a valid file', () => {
    const midi = parseSmfForTest(writeSmf(song('')));
    expect(midi.ntrks).toBe(1);
    expect(midi.tracks[0].at(-1)).toMatchObject({ type: 'eot', tick: 0 });
  });

  it('is deterministic', () => {
    const a = writeSmf(song(SAMPLE_3TRACK));
    const b = writeSmf(song(SAMPLE_3TRACK));
    expect([...a]).toEqual([...b]);
    expect(compileMml(SAMPLE_3TRACK)).toEqual(compileMml(SAMPLE_3TRACK));
  });

  it('large input stays fast', () => {
    const src = Array.from({ length: 16 }, (_, i) => `TR(${i + 1}) ${i + 1 > 15 ? 'CH(10)' : ''} l32 ` + 'cdefgab'.repeat(800)).join('\n');
    const t0 = performance.now();
    const s = song(src);
    const bytes = writeSmf(s);
    const elapsed = performance.now() - t0;
    expect(s.tracks).toHaveLength(16);
    expect(parseSmfForTest(bytes).ntrks).toBe(17);
    expect(elapsed).toBeLessThan(3000);
  });
});
