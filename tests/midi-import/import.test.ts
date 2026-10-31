// SPEC 8 Phase 4 acceptance tests L35–L44, L46 (MIDI -> MML) and additional import checks.
import { describe, expect, it } from 'vitest';
import {
  compileMml,
  importMidi,
  normalizeMidi,
  readSmf,
  writeSmf,
  type CompiledSong,
  type MidiImportOptions,
  type MidiImportResult,
  type NoteEvent,
} from '../../src/engine';
import { bend, build, cc, eot, meta, off, on, program, smf, tempo, text, trackBytes, vlq, type Ev } from '../helpers/smf-build';
import { parseSmfForTest } from '../helpers/smf-parse';

const FIDELITY: MidiImportOptions = { mode: 'fidelity' };

function imported(bytes: Uint8Array, options: MidiImportOptions = FIDELITY) {
  const r = importMidi(bytes, options);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code}: ${i.message}`).join('\n'));
  const c = compileMml(r.mml);
  if (!c.ok) throw new Error(`recompile failed:\n${r.mml}\n${c.diagnostics.map((d) => d.message).join('\n')}`);
  return { result: r, song: c.song };
}
const notes = (s: CompiledSong) =>
  s.tracks
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note')
    .map((n) => ({ ch: n.channel, pitch: n.pitch, vel: n.velocity, on: n.startTick, off: n.startTick + n.gateTicks }))
    .sort((a, b) => a.ch - b.ch || a.on - b.on || a.pitch - b.pitch);
const failCodes = (r: MidiImportResult) => (r.ok ? [] : r.issues.map((i) => i.code));

describe('acceptance L35–L44, L46', () => {
  it('L35 simple SMF0 with two channels -> two TR/CH, recompiles', () => {
    const bytes = build(0, 480, [tempo(0, 500000), program(0, 1, 48), on(0, 0, 60), on(0, 1, 48, 80), off(480, 0, 60), on(0, 0, 62), off(480, 0, 62), off(0, 1, 48)]);
    const { result, song } = imported(bytes);
    expect(result.mml).toContain('TR(1) CH(1)');
    expect(result.mml).toContain('TR(2) CH(2)');
    expect(song.tracks.map((t) => [t.number, t.channel])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 0, off: 480 },
      { ch: 0, pitch: 62, vel: 100, on: 480, off: 960 },
      { ch: 1, pitch: 48, vel: 80, on: 0, off: 960 },
    ]);
    if (result.ok) {
      expect(result.summary.originalFormat).toBe(0);
      expect(result.summary.sourceChannels).toBe(2);
      expect(result.summary.roundTrip.ok).toBe(true);
    }
  });

  it('L36 SMF1 with the same channel on separate MTrks -> merged into one TR, no channel conflict', () => {
    const bytes = build(1, 480, [tempo(0, 600000)], [text(0, 0x03, 'Piano R'), on(0, 0, 72), off(480, 0, 72)], [text(0, 0x03, 'Piano L'), on(240, 0, 48), off(480, 0, 48)]);
    const { result, song } = imported(bytes);
    expect(song.tracks).toHaveLength(1);
    expect(song.tracks[0].channel).toBe(0);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 72, vel: 100, on: 0, off: 480 },
      { ch: 0, pitch: 48, vel: 100, on: 240, off: 720 },
    ]);
    expect(result.mml).toContain('MTrk 2「Piano R」, MTrk 3「Piano L」');
    expect(song.tempoMap.map((t) => t.microsecondsPerQuarter)).toEqual([600000]);
  });

  it('L37 PPQ 96 with a tempo change: ticks scaled to 480, start and end match', () => {
    const bytes = build(1, 96, [tempo(0, 500000), tempo(192, 400000)], [on(96, 0, 60), off(48, 0, 60), on(48, 0, 64), off(96, 0, 64)]);
    const { result, song } = imported(bytes);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 480, off: 720 },
      { ch: 0, pitch: 64, vel: 100, on: 960, off: 1440 },
    ]);
    expect(song.tempoMap.map((t) => [t.tick, t.microsecondsPerQuarter])).toEqual([
      [0, 500000],
      [960, 400000],
    ]);
    if (result.ok) {
      expect(result.summary.originalPpq).toBe(96);
      expect(result.summary.roundingMaxErrorTicks).toBe(0);
    }
  });

  it('L38 running status, Note On velocity 0 and VLQ > 127 decode exactly', () => {
    // running status: status byte omitted after the first Note On; vel 0 = Note Off; deltas 200 and 20000 need 2/3 VLQ bytes.
    const events: Ev[] = [[0, 0x90, 60, 100], [200, 60, 0], [0, 64, 90], [20000, 64, 0], [0, 0x80, 67, 0]];
    const bytes = build(0, 480, events);
    expect(vlq(200)).toHaveLength(2);
    expect(vlq(20000)).toHaveLength(3);
    const read = readSmf(bytes);
    expect(read.ok).toBe(true);
    const { song } = imported(bytes);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 0, off: 200 },
      { ch: 0, pitch: 64, vel: 90, on: 200, off: 20200 },
    ]);
  });

  it('L39 same tick / length / velocity C-E-G becomes a quoted chord', () => {
    const bytes = build(0, 480, [on(0, 0, 60, 92), on(0, 0, 64, 92), on(0, 0, 67, 92), off(360, 0, 60), off(0, 0, 64), off(0, 0, 67)]);
    const { result, song } = imported(bytes);
    expect(result.mml).toMatch(/'n60 n64 n67'%360/);
    expect(notes(song)).toEqual([60, 64, 67].map((pitch) => ({ ch: 0, pitch, vel: 92, on: 0, off: 360 })));
  });

  it('L40 same tick with different lengths / velocities: exact notes, nothing dropped', () => {
    const bytes = build(0, 480, [on(0, 0, 60, 90), on(0, 0, 64, 70), on(0, 0, 67, 90), off(100, 0, 64), off(140, 0, 60), off(0, 0, 67), on(10, 0, 72, 50), off(5, 0, 72)]);
    const { result, song } = imported(bytes);
    expect(result.mml).toContain('Sub{');
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 90, on: 0, off: 240 },
      { ch: 0, pitch: 64, vel: 70, on: 0, off: 100 },
      { ch: 0, pitch: 67, vel: 90, on: 0, off: 240 },
      { ch: 0, pitch: 72, vel: 50, on: 250, off: 255 },
    ]);
  });

  it('L41 CC64, CC7, PB, GM program and CH10 drums are reflected and written to SMF', () => {
    const bytes = build(
      1,
      480,
      [tempo(0, 500000)],
      [program(0, 0, 48), cc(0, 0, 7, 100), on(0, 0, 60), cc(120, 0, 64, 127), bend(0, 0, -1024), off(240, 0, 60), cc(120, 0, 64, 0), bend(0, 0, 0)],
      [on(0, 9, 36, 110), on(0, 9, 42, 80), off(120, 9, 36), off(0, 9, 42), on(360, 9, 38, 100), off(120, 9, 38)],
    );
    const { result, song } = imported(bytes);
    for (const s of ['@49', 'CC(7,100)', 'CC(64,127)', 'PB(-1024)', 'CC(64,0)', 'PB(0)', 'TR(10) CH(10)']) expect(result.mml).toContain(s);
    const midi = parseSmfForTest(writeSmf(song));
    const all = midi.tracks.flat();
    expect(all.filter((e) => e.type === 'cc').map((e) => [e.tick, e.data[0], e.data[1]])).toEqual([
      [0, 7, 100],
      [120, 64, 127],
      [480, 64, 0],
    ]);
    expect(all.filter((e) => e.type === 'pitchbend').map((e) => [e.tick, (e.data[0] | (e.data[1] << 7)) - 8192])).toEqual([
      [120, -1024],
      [480, 0],
    ]);
    expect(all.filter((e) => e.type === 'program' && e.channel === 0).map((e) => e.data[0])).toEqual([48]);
    expect(all.filter((e) => e.type === 'noteOn' && e.channel === 9).map((e) => [e.tick, e.data[0], e.data[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([
      [0, 36, 110],
      [0, 42, 80],
      [480, 38, 100],
    ]);
    // pedal does not lengthen the note: gate = real Note Off
    expect(notes(song).find((n) => n.pitch === 60)).toEqual({ ch: 0, pitch: 60, vel: 100, on: 0, off: 360 });
  });

  it('L42 fidelity SMF -> MML -> SMF keeps notes / tempo / program / CC / PB (PPQ rounding only)', () => {
    const bytes = build(
      1,
      96,
      [tempo(0, 512345), tempo(384, 450000)],
      [program(0, 2, 10), on(0, 2, 70, 33), cc(7, 2, 11, 90), bend(5, 2, 4000), off(41, 2, 70), on(1, 2, 70, 44), off(13, 2, 70)],
      [on(3, 9, 49, 127), off(1, 9, 49)],
    );
    const { song } = imported(bytes);
    // Read our own SMF back and compare with the original, both normalised to 480 PPQ.
    const original = normalizeMidi((readSmf(bytes) as { ok: true; midi: never }).midi).song;
    const again = normalizeMidi((readSmf(writeSmf(song)) as { ok: true; midi: never }).midi).song;
    const strip = (s: typeof original) => s.channels.map((c) => ({ channel: c.channel, notes: c.notes, controls: c.controls }));
    expect(strip(again)).toEqual(strip(original));
    expect(again.tempos).toEqual(original.tempos);
  });

  it('L43 readable mode quantises an off-grid note to 120-tick grid and reports the difference', () => {
    const bytes = build(0, 480, [on(130, 0, 60), off(250, 0, 60), on(0, 0, 64), off(480, 0, 64)]);
    const { result, song } = imported(bytes, { mode: 'readable', quantize: '1/16' });
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 120, off: 360 },
      { ch: 0, pitch: 64, vel: 100, on: 360, off: 840 },
    ]);
    expect(result.mml).toContain('Time(1:1:0) r16 o4 c8 e');
    if (result.ok) {
      expect(result.summary.quantize?.notesMoved).toBe(2);
      expect(result.summary.quantize?.maxStartShift).toBe(20);
      expect(result.summary.warnings.join('\n')).toContain('量子化');
    }
    // other grids
    const eighth = imported(bytes, { mode: 'readable', quantize: '1/8' }).song;
    expect(notes(eighth)[0].on).toBe(240);
    const thirtySecond = imported(bytes, { mode: 'readable', quantize: '1/32' }).song;
    expect(notes(thirtySecond)[0].on).toBe(120);
  });

  it('L44 Type 2, SMPTE, broken VLQ, oversized and truncated files are rejected safely', () => {
    expect(failCodes(importMidi(build(2, 480, [on(0, 0, 60), off(10, 0, 60)]), FIDELITY))).toEqual(['E_MIDI_FORMAT2']);
    expect(failCodes(importMidi(smf(1, 0xe728, [trackBytes([on(0, 0, 60), off(10, 0, 60)])]), FIDELITY))).toEqual(['E_MIDI_SMPTE']);
    const brokenVlq = smf(0, 480, [[...'MTrk'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 8, 0x81, 0x81, 0x81, 0x81, 0x01, 0x90, 60, 100])]);
    expect(failCodes(importMidi(brokenVlq, FIDELITY))).toEqual(['E_MIDI_VLQ']);
    expect(failCodes(importMidi(new Uint8Array(20 * 1024 * 1024 + 1), FIDELITY))).toEqual(['E_MIDI_TOO_LARGE']);
    expect(failCodes(importMidi(new Uint8Array([1, 2, 3]), FIDELITY))).toEqual(['E_MIDI_HEADER']);
    const good = build(0, 480, [on(0, 0, 60), off(10, 0, 60)]);
    expect(failCodes(importMidi(good.slice(0, good.length - 3), FIDELITY))).toEqual(['E_MIDI_CHUNK_LENGTH']);
    expect(failCodes(importMidi(smf(1, 480, [trackBytes([on(0, 0, 60)])], 2), FIDELITY))).toEqual(['E_MIDI_TRUNCATED']);
    expect(failCodes(importMidi(build(0, 480, [[0, 60, 100]]), FIDELITY))).toEqual(['E_MIDI_RUNNING_STATUS']);
    expect(failCodes(importMidi(build(0, 480, [[0, 0x90, 60, 0x91]]), FIDELITY))).toEqual(['E_MIDI_DATA']);
    const r = importMidi(build(2, 480, []), FIDELITY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.originalPlayable).toBe(false);
      expect(r.issues[0].message).toContain('Format 2');
    }
  });

  it('L46 time signature / lyrics / SysEx / unsupported events are counted as lost; original bytes kept', () => {
    const bytes = build(
      1,
      480,
      [tempo(0, 500000), meta(0, 0x58, [3, 2, 24, 8]), meta(0, 0x59, [0, 0]), text(0, 0x06, 'A')],
      [[0, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7], text(0, 0x05, 'ら'), on(0, 0, 60), text(240, 0x05, 'ら'), [0, 0xd0, 40], [0, 0xa0, 60, 30], off(240, 0, 60)],
    );
    const copy = bytes.slice();
    const r = importMidi(bytes, FIDELITY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.lostEvents).toEqual({
      '拍子（Time Signature）': 1,
      '調号（Key Signature）': 1,
      マーカー: 1,
      SysEx: 1,
      歌詞: 2,
      チャンネルアフタータッチ: 1,
      ポリフォニックアフタータッチ: 1,
    });
    expect(r.summary.warnings.some((w) => w.includes('歌詞 × 2'))).toBe(true);
    expect([...r.originalSmf]).toEqual([...copy]);
    expect(r.originalSmf).not.toBe(bytes);
    expect([...bytes]).toEqual([...copy]); // input untouched
  });
});

describe('import edge cases (SPEC 8 追加確認)', () => {
  it('overlapping same channel + pitch: previous note is shortened with a warning (FIFO Note Off)', () => {
    const bytes = build(0, 480, [on(0, 0, 60), on(100, 0, 60), off(100, 0, 60), off(100, 0, 60)]);
    const { result, song } = imported(bytes);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 0, off: 100 },
      { ch: 0, pitch: 60, vel: 100, on: 100, off: 300 },
    ]);
    if (result.ok) expect(result.summary.warnings.join()).toContain('重なって');
  });

  it('unterminated notes end at the end of the song, with a warning', () => {
    const bytes = build(0, 480, [on(0, 0, 60), on(0, 0, 64), off(480, 0, 64), eot(480)]);
    const { result, song } = imported(bytes);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 0, off: 960 },
      { ch: 0, pitch: 64, vel: 100, on: 0, off: 480 },
    ]);
    if (result.ok) expect(result.summary.warnings.join()).toContain('Note Off のないノート');
  });

  it('zero-length notes are corrected to 1 tick; rounding error is reported', () => {
    const bytes = build(0, 960, [on(1, 0, 60), off(0, 0, 60), on(10, 0, 62), off(3, 0, 62)]);
    const { result, song } = imported(bytes);
    expect(notes(song)).toEqual([
      { ch: 0, pitch: 60, vel: 100, on: 1, off: 2 },
      { ch: 0, pitch: 62, vel: 100, on: 6, off: 7 },
    ]);
    if (result.ok) {
      expect(result.summary.roundingMaxErrorTicks).toBe(0.5);
      expect(result.summary.warnings.join()).toContain('最短 1 tick');
    }
  });

  it('tempo changes and rewinding Time in the generated MML coexist', () => {
    const bytes = build(1, 480, [tempo(0, 500000), tempo(1920, 750000), tempo(1920, 500000)], [on(3000, 0, 60), off(100, 0, 60)], [on(0, 0, 72), off(100, 0, 72)]);
    const { result, song } = imported(bytes);
    expect(song.tempoMap.map((t) => t.tick)).toEqual([0, 1920, 3840]);
    expect(notes(song).map((n) => n.on)).toEqual([0, 3000]);
    expect(result.mml).toContain('TempoUS(750000)');
  });

  it('a track name in UTF-8 appears in a comment; Shift_JIS-like bytes do not break the MML', () => {
    const bytes = build(1, 480, [], [text(0, 0x03, 'ピアノ */ \n x'), on(0, 0, 60), off(10, 0, 60)], [meta(0, 0x03, [0x83, 0x73, 0x83, 0x41]), on(0, 1, 60), off(10, 1, 60)]);
    const { result } = imported(bytes);
    expect(result.mml).toContain('「ピアノ */ x」');
    expect(result.mml).toContain('「?s?A」');
  });

  it('the default q90 never leaks into fidelity output', () => {
    const { result } = imported(build(0, 480, [on(0, 0, 60), off(480, 0, 60)]));
    expect(result.mml).toContain('q%480');
  });

  it('empty MIDI (no notes) converts to an empty-but-valid MML', () => {
    const { song } = imported(build(0, 480, [tempo(0, 400000)]));
    expect(song.tracks).toEqual([]);
    expect(song.tempoMap.map((t) => t.microsecondsPerQuarter)).toEqual([400000]);
  });

  it('end of track beyond the last note keeps the song length', () => {
    const { song } = imported(build(0, 480, [on(0, 0, 60), off(480, 0, 60), eot(1440)]));
    expect(song.endTick).toBe(1920);
  });

  it('drum program changes are reported as lost', () => {
    const r = importMidi(build(0, 480, [program(0, 9, 25), on(0, 9, 36), off(120, 9, 36)]), FIDELITY);
    expect(r.ok && r.summary.lostEvents['ドラム（CH10）の Program Change（キット変更）']).toBe(1);
  });

  it('too long for MML: conversion refused, original stays playable', () => {
    const r = importMidi(build(0, 480, [on(0, 0, 60), off(2_100_000, 0, 60)]), FIDELITY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.originalPlayable).toBe(true);
      expect(r.issues[0].code).toBe('E_IMPORT_TOO_LONG');
    }
  });

  it('readable mode: collision after quantisation falls back to exact ticks for that channel', () => {
    const bytes = build(0, 480, [on(0, 0, 60), off(20, 0, 60), on(20, 0, 60), off(40, 0, 60), on(0, 1, 50), off(500, 1, 50)]);
    const r = importMidi(bytes, { mode: 'readable' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.quantize?.fallbackChannels).toEqual([1]);
      expect(r.summary.warnings.join()).toContain('忠実度優先の書式');
    }
  });

  it('readable mode uses note names, octaves, rests, chords and multiple voices', () => {
    const bytes = build(
      1,
      480,
      [tempo(0, 500000)],
      [on(0, 0, 60), on(0, 0, 64), on(0, 0, 67), off(480, 0, 60), off(0, 0, 64), off(0, 0, 67), on(480, 0, 72), off(240, 0, 72), on(0, 0, 71), off(240, 0, 71)],
      [on(0, 0, 48), off(1920, 0, 48)],
    );
    const { result, song } = imported(bytes, { mode: 'readable' });
    expect(result.mml).toContain("'ceg'");
    expect(result.mml).toContain('Tempo(120)');
    expect(result.mml).toContain('声部 2');
    expect(notes(song).map((n) => [n.pitch, n.on, n.off])).toEqual([
      [48, 0, 1920],
      [60, 0, 480],
      [64, 0, 480],
      [67, 0, 480],
      [72, 960, 1200],
      [71, 1200, 1440],
    ]);
  });
});

describe('randomised fidelity round trip', () => {
  // Deterministic PRNG so failures are reproducible.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const ppq = [96, 120, 192, 384, 480, 960][Math.floor(r() * 6)];
      const tracks: Ev[][] = [[tempo(0, 400000 + Math.floor(r() * 300000)), tempo(Math.floor(r() * ppq * 8), 300000 + Math.floor(r() * 500000))]];
      for (let t = 0; t < 1 + Math.floor(r() * 4); t++) {
        const evs: { tick: number; ev: number[] }[] = [];
        for (let i = 0; i < 60; i++) {
          const ch = Math.floor(r() * 16);
          const start = Math.floor(r() * ppq * 16);
          const pitch = 30 + Math.floor(r() * 60);
          evs.push({ tick: start, ev: [0x90 | ch, pitch, 1 + Math.floor(r() * 127)] });
          evs.push({ tick: start + 1 + Math.floor(r() * ppq * 2), ev: [0x80 | ch, pitch, 0] });
          if (r() < 0.2) evs.push({ tick: start, ev: [0xb0 | ch, Math.floor(r() * 120), Math.floor(r() * 128)] });
          if (r() < 0.1) evs.push({ tick: start, ev: [0xe0 | ch, Math.floor(r() * 128), Math.floor(r() * 128)] });
          if (r() < 0.05 && ch !== 9) evs.push({ tick: start, ev: [0xc0 | ch, Math.floor(r() * 128)] });
        }
        evs.sort((a, b) => a.tick - b.tick);
        let last = 0;
        tracks.push(
          evs.map((e) => {
            const d = e.tick - last;
            last = e.tick;
            return [d, ...e.ev] as Ev;
          }),
        );
      }
      const bytes = build(1, ppq, ...tracks);
      const res = importMidi(bytes, FIDELITY);
      if (!res.ok) throw new Error(res.issues.map((i) => i.message).join('\n'));
      expect(res.summary.roundTrip.ok).toBe(true);
      expect(res.summary.roundTrip.compared.notes).toBeGreaterThan(50);
      const readable = importMidi(bytes, { mode: 'readable', quantize: '1/32' });
      if (!readable.ok) throw new Error(readable.issues.map((i) => i.message).join('\n'));
      expect(readable.summary.roundTrip.ok).toBe(true);
    });
  }
});

describe('reader leniency for real-world files (warned, never silent)', () => {
  const warnCodes = (bytes: Uint8Array) => {
    const r = readSmf(bytes);
    if (!r.ok) throw new Error(r.errors[0].message);
    return r.midi.warnings.map((w) => w.code);
  };

  it('MTrk length off by one: recovered only when the next MTrk follows End of Track', () => {
    const t0 = trackBytes([tempo(0, 500000)]);
    t0[7] -= 1; // declared length one byte short
    const t1 = trackBytes([on(0, 0, 60), off(480, 0, 60)]);
    const bytes = smf(1, 480, [t0, t1]);
    expect(warnCodes(bytes)).toContain('W_MIDI_CHUNK_LENGTH_FIXED');
    const { song } = imported(bytes);
    expect(notes(song)).toEqual([{ ch: 0, pitch: 60, vel: 100, on: 0, off: 480 }]);
    // not followed by MTrk -> still an error
    const garbage = smf(1, 480, [t0, [1, 2, 3, 4, 5, 6, 7, 8, 9]], 1);
    expect(readSmf(garbage).ok).toBe(false);
  });

  it('last MTrk length overstated: recovered when End of Track is reached at the end of the file', () => {
    const t = trackBytes([on(0, 0, 60), off(10, 0, 60)]);
    t[7] += 100;
    expect(warnCodes(smf(0, 480, [t]))).toContain('W_MIDI_CHUNK_LENGTH_FIXED');
  });

  it('running status after a meta event uses the previous channel status', () => {
    const bytes = build(0, 480, [on(0, 0, 60), text(0, 0x01, 'x'), [480, 60, 0]]);
    expect(warnCodes(bytes)).toContain('W_MIDI_RUNNING_AFTER_META');
    expect(notes(imported(bytes).song)).toEqual([{ ch: 0, pitch: 60, vel: 100, on: 0, off: 480 }]);
  });

  it('MacBinary and RIFF RMID containers are unwrapped', () => {
    const inner = build(0, 480, [on(0, 0, 60), off(10, 0, 60)]);
    const mac = new Uint8Array(128 + inner.length);
    mac[1] = 4;
    mac.set([...'SONG'].map((c) => c.charCodeAt(0)), 2);
    const n = inner.length;
    mac.set([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff], 83);
    mac.set(inner, 128);
    expect(warnCodes(mac)).toContain('W_MIDI_MACBINARY');
    const le = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    const riff = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat(le(12 + n), [...'RMIDdata'].map((c) => c.charCodeAt(0)), le(n), [...inner]));
    expect(warnCodes(riff)).toContain('W_MIDI_RMID');
    expect(notes(imported(riff).song)).toHaveLength(1);
  });
});
