// SPEC 8 Phase 6a acceptance tests L47–L61: PC-9801 PLAY (article format) -> MML Studio MML.
// All inputs are self-made (no third-party MML in the repository).
import { describe, expect, it } from 'vitest';
import { compileMml, type CompiledSong, type NoteEvent } from '../../src/engine';
import { convertDialect, guessDialect, listDialectSongs } from '../../src/engine/dialects';

function conv(text: string, songIndex = 0) {
  const r = convertDialect(text, 'pc98-play', { songIndex });
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}:${e.column} ${e.code} ${e.message}`).join('\n'));
  const c = compileMml(r.mml);
  if (!c.ok) throw new Error(`recompile failed\n${r.mml}`);
  return { r, song: c.song };
}
const notes = (s: CompiledSong, track?: number) =>
  s.tracks
    .filter((t) => track === undefined || t.number === track)
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note');
/** One part, one line. */
const one = (mml: string) => `10 "${mml}"`;
const codes = (r: ReturnType<typeof convertDialect>) => (r.ok ? r.warnings.map((w) => w.code) : r.errors.map((e) => e.code));

describe('PC-9801 PLAY acceptance L47–L61', () => {
  it('L47 header + 2 data lines with 3 parts: parts concatenated in line order, title kept', () => {
    const { r, song } = conv(`"0101","テスト曲",2,3,6
01 "O4CD","O3E","O5G"
02 "EF","F","A"`);
    expect(song.tracks.map((t) => t.number)).toEqual([1, 2, 3]);
    expect(notes(song, 1).map((n) => [n.pitch, n.startTick])).toEqual([
      [60, 0],
      [62, 480],
      [64, 960],
      [65, 1440],
    ]);
    expect(notes(song, 2).map((n) => n.pitch)).toEqual([52, 53]);
    expect(notes(song, 3).map((n) => n.pitch)).toEqual([79, 81]);
    expect(r.ok && r.mml).toContain('PC-9801 PLAY から変換: テスト曲');
    expect(r.ok && r.mml).toContain('// 02');
  });

  it('L48 O / L / V / Q / @ carry over to the next line per part', () => {
    const { song } = conv(`10 "O5L8V15Q4@46C","O3L2C"
20 "D","D"`);
    expect(notes(song, 1).map((n) => [n.pitch, n.durationTicks, n.velocity, n.gateTicks])).toEqual([
      [72, 240, 127, 120],
      [74, 240, 127, 120],
    ]);
    expect(notes(song, 2).map((n) => [n.pitch, n.durationTicks])).toEqual([
      [48, 960],
      [50, 960],
    ]);
    expect(song.tracks[0].events.find((e) => e.kind === 'program')).toMatchObject({ program: 6 }); // @7 Harpsichord
  });

  it('L49 dots: L8 C.. / C. / C32', () => {
    const { r, song } = conv(one('Q8L8C..D.E32'));
    expect(notes(song).map((n) => n.durationTicks)).toEqual([420, 360, 60]);
    expect(r.ok && r.mml).toContain('c8.^32'); // 420 = 360 + 60
    expect(codes(r)).toContain('W_DIALECT_DOTS');
  });

  it('L50 non-standard lengths L6 / L12 / L3', () => {
    const { song } = conv(one('L6CL12DL3E'));
    expect(notes(song).map((n) => n.durationTicks)).toEqual([320, 160, 640]);
  });

  it('L51 tuplets {CDE}4 and {CDEFG}4', () => {
    const { song } = conv(one('{CDE}4{CDEFG}4'));
    expect(notes(song).map((n) => n.durationTicks)).toEqual([160, 160, 160, 96, 96, 96, 96, 96]);
    expect(notes(song).map((n) => n.startTick)).toEqual([0, 160, 320, 480, 576, 672, 768, 864]);
    // uneven division: total stays exact
    const { song: s2 } = conv(one('{CDEFGAB}4'));
    expect(notes(s2).reduce((a, n) => a + n.durationTicks, 0)).toBe(480);
  });

  it('L52 V15 / V8 / @V110 / V8@V100 velocities', () => {
    const { song } = conv(one('V15C V8C @V110C V8@V100C'));
    expect(notes(song).map((n) => n.velocity)).toEqual([127, 68, 110, 100]);
  });

  it('L53 Q8 / Q7 / Q4 gates at L4', () => {
    const { song } = conv(one('Q8C Q7C Q4C'));
    expect(notes(song).map((n) => n.gateTicks)).toEqual([480, 422, 240]);
  });

  it('L54 O4C / O4A / >C / <C pitches', () => {
    const { song } = conv(one('O4CA>C<<C'));
    expect(notes(song).map((n) => n.pitch)).toEqual([60, 69, 72, 48]);
  });

  it('L55 tempo: same T merged, a different T on another part is ignored with one warning', () => {
    const r = convertDialect('10 "T140C","T140E","T100G"', 'pc98-play');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = compileMml(r.mml);
    expect(s.ok && s.song.tempoMap.map((t) => [t.tick, t.bpm])).toEqual([[0, 140]]);
    expect(r.warnings.filter((w) => w.code === 'W_DIALECT_TEMPO')).toHaveLength(1);
    // mid-song tempo change lands on TR(0) with Time
    const m = conv(one('T120C1T90C1'));
    expect(m.song.tempoMap.map((t) => [t.tick, t.bpm])).toEqual([
      [0, 120],
      [1920, 90],
    ]);
  });

  it('L56 voices: @46 -> @7, @13 -> @1, part 4 defaults to a square wave, names in comments', () => {
    const { r, song } = conv('10 "@46C","@13C","C","C"');
    const prog = (n: number) => song.tracks.find((t) => t.number === n)!.events.find((e) => e.kind === 'program');
    expect(prog(1)).toMatchObject({ program: 6 });
    expect(prog(2)).toMatchObject({ program: 0 });
    expect(prog(4)).toMatchObject({ program: 80 }); // @81 Lead 1 (square)
    expect(r.ok && r.mml).toContain('// @46 HARPSIC → @7 Harpsichord');
  });

  it('L57 Z0,3 / S / M / Y are warned with counts, MB is silent, notes still convert', () => {
    const r = convertDialect('10 "MBZ0,3S1M255Y1,2CZ0,3D"', 'pc98-play');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const z = r.warnings.find((w) => w.code === 'W_DIALECT_Z');
    expect(z?.count).toBe(2);
    expect(codes(r)).toEqual(expect.arrayContaining(['W_DIALECT_Z', 'W_DIALECT_ENVELOPE', 'W_DIALECT_REGISTER']));
    expect(r.warnings.map((w) => w.message).join()).not.toContain('MB');
    expect(notes((compileMml(r.mml) as { ok: true; song: CompiledSong }).song)).toHaveLength(2);
  });

  it('L58 spaces inside the data are ignored; lowercase is accepted', () => {
    const { song } = conv(one('O4A #O5C < A> c'));
    expect(notes(song).map((n) => n.pitch)).toEqual([70, 72, 69, 72]);
  });

  it('L59 two songs: listed, and only the selected one is converted', () => {
    const text = `"0001","曲A",1,1,1
01 "CDE"
"0002","曲B",1,1,1
01 "GAB"`;
    expect(listDialectSongs(text, 'pc98-play')).toEqual([
      { index: 0, title: '曲A', startLine: 1, parts: 1 },
      { index: 1, title: '曲B', startLine: 3, parts: 1 },
    ]);
    expect(notes(conv(text, 1).song).map((n) => n.pitch)).toEqual([67, 69, 71]);
  });

  it('L60 invalid characters, BASIC statements and unterminated quotes are errors with positions', () => {
    const bad = (text: string) => {
      const r = convertDialect(text, 'pc98-play');
      expect(r.ok).toBe(false);
      return r.ok ? null : r.errors[0];
    };
    expect(bad('10 "CDX"')).toMatchObject({ code: 'E_DIALECT_CHAR', line: 1, column: 7 });
    expect(bad('10 "C"\n20 GOTO 10')).toMatchObject({ code: 'E_DIALECT_LINE', line: 2 });
    expect(bad('10 "CDE')).toMatchObject({ code: 'E_DIALECT_QUOTE', line: 1, column: 4 });
    expect(bad('10 "V16C"')).toMatchObject({ code: 'E_DIALECT_RANGE' });
    expect(bad('10 "a","b","c","d","e","f","g"')).toMatchObject({ code: 'E_DIALECT_PARTS' });
    expect(bad('')).toMatchObject({ code: 'E_DIALECT_NO_DATA' });
  });

  it('L61 every conversion recompiles and matches the converter (verified)', () => {
    const { r } = conv(`"0001","総合",3,3,6
01 "MBQ6L8@24T120@V100Z0,3","MBQ8L4@64T120V10","MBL2@4T120V12"
02 "O4C..C32DEF+GA-B-B","O3E..E32G< B> D#","O2CG"
03 "{ER32.D32E}4{CCC}4G^8&G8A&B","O3C2^4R4","N30N0N52"`);
    expect(r.ok && r.summary.verified).toBe(true);
    expect(r.ok && r.summary.parts).toBe(3);
  });
});

describe('PC-9801 PLAY extras', () => {
  it('& ties the same pitch into one note; a different pitch becomes legato with a warning', () => {
    const { song } = conv(one('Q4C&C D&E'));
    expect(notes(song).map((n) => [n.pitch, n.durationTicks, n.gateTicks])).toEqual([
      [60, 960, 480],
      [62, 480, 480],
      [64, 480, 240],
    ]);
    expect(codes(convertDialect(one('D&E'), 'pc98-play'))).toContain('W_DIALECT_SLUR');
  });

  it('^ adds a length to the previous note or rest', () => {
    const { song } = conv(one('C4^8R4^4D'));
    expect(notes(song).map((n) => [n.startTick, n.durationTicks])).toEqual([
      [0, 720],
      [1680, 480],
    ]);
  });

  it('PLAY keyword and CRLF line endings are accepted', () => {
    expect(notes(conv('10 PLAY "CD","E"\r\n20 PLAY "E"\r\n').song)).toHaveLength(4);
  });

  it('pitches below MIDI 12 are written as nN', () => {
    expect(notes(conv(one('O0C-')).song).map((n) => n.pitch)).toEqual([11]);
  });

  it('empty parts ("") produce no track', () => {
    const { r, song } = conv('10 "CDE","",""');
    expect(song.tracks.map((t) => t.number)).toEqual([1]);
    expect(r.ok && r.summary.parts).toBe(1);
  });

  it('dialect guess', () => {
    expect(guessDialect('10 "CDE"')).toBe('pc98-play');
    expect(guessDialect('TR(1) cde')).toBeNull();
  });
});
