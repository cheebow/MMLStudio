// Piano roll data (SPEC 6.3): seconds from the tempo map, visible / sounding notes, pitch window.
import { describe, expect, it } from 'vitest';
import { compileMml, writeSmf } from '../../src/engine';
import { levelAt, notesAt, notesBetween, pitchName, pitchWindow, rollFromMidi, rollFromSong, tickClock, valueAt } from '../../src/ui/roll-data';

const song = (mml: string) => {
  const c = compileMml(mml);
  if (!c.ok) throw new Error(JSON.stringify(c.diagnostics));
  return c.song;
};

describe('piano roll data', () => {
  it('converts ticks to seconds through tempo changes', () => {
    const clock = tickClock([
      { tick: 0, microsecondsPerQuarter: 500_000 },
      { tick: 960, microsecondsPerQuarter: 1_000_000 },
    ]);
    expect(clock(480)).toBeCloseTo(0.5);
    expect(clock(960)).toBeCloseTo(1);
    expect(clock(1440)).toBeCloseTo(2);
  });

  it('notes from MML: seconds, gate length, lanes per track, drums, source spans, bars', () => {
    const d = rollFromSong(song('TR(0) Tempo(120)\nTR(1) CH(1) l4 q50 c d\nTR(2) CH(10) n36'));
    expect(d.notes.map((n) => [n.pitch, n.start, n.end, n.lane, n.drum])).toEqual([
      [36, 0, 0.5 * 0.9, 1, true],
      [60, 0, 0.25, 0, false],
      [62, 0.5, 0.75, 0, false],
    ]);
    expect(d.notes[1].source).toBeDefined();
    expect(d.tracks.map((t) => t.label)).toEqual(['TR1', 'TR2']);
    expect(d.bars[0]).toBe(0);
    expect([d.low, d.high]).toEqual([60, 62]);
  });

  it('visible and sounding notes', () => {
    const d = rollFromSong(song('TR(1) CH(1) l4 c d e f\nTR(2) CH(2) l1 g'));
    expect(notesBetween(d, 0.6, 1.1).map((n) => n.pitch)).toEqual([67, 62, 64]);
    expect(notesAt(d, 1.2).map((n) => n.pitch).sort()).toEqual([64, 67]);
  });

  it('pitch window keeps at least two octaves; names use C4 = 60', () => {
    expect(pitchWindow(rollFromSong(song('TR(1) CH(1) c')))).toEqual({ low: 48, high: 72 });
    expect(pitchName(60)).toBe('C4');
    expect(pitchName(61)).toBe('C#4');
  });

  it('notes from the original MIDI bytes', () => {
    const d = rollFromMidi(writeSmf(song('TR(1) CH(3) l8 c e')));
    expect(d?.notes.map((n) => [n.pitch, n.channel])).toEqual([
      [60, 2],
      [64, 2],
    ]);
    expect(d?.tracks[0].label).toBe('CH3');
    expect(rollFromMidi(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('channel timelines: program / volume / expression / pan / pitch bend at a time', () => {
    const d = rollFromSong(song('TR(0) Tempo(120)\nTR(1) CH(1) @41 CC(7,90) CC(10,20) l4 c @57 CC(11,64) PB(-4096) d'));
    const tr = d.tracks[0];
    expect(valueAt(tr.program, 0, 0)).toBe(40);
    expect(valueAt(tr.program, 0.6, 0)).toBe(56);
    expect(valueAt(tr.volume, 0.2, 100)).toBe(90);
    expect(valueAt(tr.pan, 0.2, 64)).toBe(20);
    expect(valueAt(tr.expression, 0.2, 127)).toBe(127);
    expect(valueAt(tr.expression, 0.6, 127)).toBe(64);
    expect(valueAt(tr.bend, 0.6, 0)).toBe(-4096);
    // the same from the original MIDI bytes
    const m = rollFromMidi(writeSmf(song('TR(1) CH(1) @41 CC(7,90) c')))!;
    expect(valueAt(m.tracks[0].program, 0, 0)).toBe(40);
    expect(valueAt(m.tracks[0].volume, 0, 100)).toBe(90);
  });

  it('level meter: loudest recent note-on, decaying over 0.6 s', () => {
    const d = rollFromSong(song('TR(0) Tempo(120)\nTR(1) CH(1) v127 l1 c\nTR(2) CH(2) r1'));
    expect(levelAt(d, 0, 0)).toBeCloseTo(1);
    expect(levelAt(d, 0, 0.3)).toBeCloseTo(0.5);
    expect(levelAt(d, 0, 0.7)).toBe(0);
    expect(levelAt(d, 1, 0.1)).toBe(0);
  });
});
