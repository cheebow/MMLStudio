// SPEC 8 Phase 6e acceptance tests L100–L114: MSX-BASIC / PC-8801 N88-BASIC music programs.
// All inputs are self-made.
import { describe, expect, it } from 'vitest';
import { compileMml, type CompiledSong, type NoteEvent } from '../../src/engine';
import { convertDialect, guessDialect, type DialectId } from '../../src/engine/dialects';

function conv(text: string, dialect: DialectId = 'msx-basic', bestEffort = false) {
  const r = convertDialect(text, dialect, { bestEffort });
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}:${e.column} ${e.code} ${e.message}`).join('\n'));
  const c = compileMml(r.mml);
  if (!c.ok) throw new Error(`recompile failed\n${r.mml}`);
  return { r, song: c.song, mml: r.mml, codes: r.warnings.map((w) => w.code) };
}
const notes = (s: CompiledSong, channel?: number) =>
  s.tracks
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note' && (channel === undefined || e.channel === channel - 1))
    .sort((a, b) => a.channel - b.channel || a.startTick - b.startTick || a.pitch - b.pitch);
const pitches = (text: string, channel = 1, dialect: DialectId = 'msx-basic') => notes(conv(text, dialect).song, channel).map((n) => n.pitch);
const err = (text: string, dialect: DialectId = 'msx-basic') => {
  const r = convertDialect(text, dialect);
  expect(r.ok, text).toBe(false);
  return r.ok ? null : r.errors[0];
};

describe('BASIC programs L100–L105 (shared)', () => {
  it('L100 string variables, concatenation, LET, CHR$ / MID$, empty PLAY arguments', () => {
    const t = `10 A$="CD":LET B$=A$+"E"+CHR$(70)
20 C$=MID$("XXGAB",3,2)
30 PLAY B$,,C$`;
    expect(pitches(t, 1)).toEqual([60, 62, 64, 65]);
    expect(pitches(t, 3)).toEqual([67, 69]);
    expect(notes(conv(t).song, 2)).toHaveLength(0);
  });

  it('L101 READ / DATA (quoted and unquoted), RESTORE, FOR / NEXT with STEP and nesting', () => {
    const t = `10 FOR I=1 TO 2:READ A$:PLAY A$:NEXT
20 RESTORE:READ A$:PLAY A$
30 FOR I=3 TO 1 STEP -1:FOR J=1 TO 2:PLAY "C":NEXT J,I
40 DATA "D",E`;
    expect(pitches(t)).toEqual([62, 64, 62, ...Array(6).fill(60)]);
  });

  it('L102 GOSUB / RETURN, ON ... GOTO, IF THEN / ELSE with line numbers and statements', () => {
    const t = `10 GOSUB 100:GOSUB 100
20 N=2:ON N GOTO 30,40
30 PLAY "C":END
40 IF N=2 THEN PLAY "E" ELSE PLAY "G"
50 IF N<>2 THEN 30 ELSE 60
60 END
100 PLAY "D":RETURN`;
    expect(pitches(t)).toEqual([62, 62, 64]);
  });

  it('L103 an endless GOTO repeat plays once; a counted loop plays every time', () => {
    const { song, codes } = conv('10 A$="CDE"\n20 PLAY A$\n30 GOTO 20');
    expect(notes(song).map((n) => n.pitch)).toEqual([60, 62, 64]);
    expect(codes).toContain('W_BASIC_REPEAT');
    expect(pitches('10 PLAY "C":K=K+1:IF K<3 THEN 10')).toEqual([60, 60, 60]);
    // READ loop ending at an end marker
    expect(pitches('10 READ A$:IF A$="END" THEN END\n20 PLAY A$:GOTO 10\n30 DATA C,D,END')).toEqual([60, 62]);
  });

  it('L104 crunched code without spaces; MSX variable names are significant to 2 characters', () => {
    expect(pitches('10 FORI=1TO2:PLAY"C":NEXT')).toEqual([60, 60]);
    expect(pitches('10 ABC$="E":PLAY ABD$')).toEqual([64]);
    expect(pitches('10 ABC$="E":ABD$="G":CMD PLAY ABC$', 1, 'pc88-basic')).toEqual([64]);
  });

  it('L105 INPUT / RND / unknown statements are errors; best-effort skips them with warnings', () => {
    expect(err('10 INPUT A$\n20 PLAY "C"')?.code).toBe('E_BASIC_UNSUPPORTED');
    expect(err('10 PLAY "C"+STR$(RND(1))')?.code).toBe('E_BASIC_UNSUPPORTED');
    expect(err('10 FOO 1')?.code).toBe('E_BASIC_UNSUPPORTED');
    expect(pitches('10 PLAY "C"\n\x1a')).toEqual([60]); // Ctrl-Z ends an ASCII file
    const { song, r, mml } = conv('10 INPUT A$\n20 PLAY "CJ"\n30 PLAY "D"', 'msx-basic', true);
    expect(notes(song).map((n) => n.pitch)).toEqual([60, 62]);
    expect(r.ok && r.summary.approximate).toBe(true);
    expect(mml).toContain('近似変換');
  });
});

describe('MSX-BASIC L106–L110', () => {
  it('L106 PLAY: three PSG parts, defaults O4 L4 T120 V8, envelopes and @ are not converted', () => {
    const { song, codes, mml } = conv('10 PLAY "S8M3000C","@5O5E8","V15G"');
    expect(notes(song).map((n) => [n.channel, n.pitch, n.durationTicks, n.velocity])).toEqual([
      [0, 60, 480, 68],
      [1, 76, 240, 68],
      [2, 67, 480, 127],
    ]);
    expect(codes).toEqual(expect.arrayContaining(['W_DIALECT_ENVELOPE', 'W_MSX_PSG_VOICE']));
    expect(mml).toContain('@81');
    expect(err('10 PLAY "C","D","E","F"')?.code).toBe('E_MSX_PARTS');
    // MSX: each dot multiplies by 1.5 (`..` = 9/4); Q has no effect on PSG
    expect(notes(conv('10 PLAY "C4..Q4D"').song).map((n) => [n.durationTicks, n.gateTicks])).toEqual([
      [1080, 1080],
      [480, 480],
    ]);
  });

  it('L107 CALL MUSIC layouts for PLAY #2 (FM, rhythm, PSG) and CALL VOICE / @ voices', () => {
    const t = `10 CALL MUSIC
20 CALL VOICE(@16)
30 PLAY #2,"C","@33D","E","B","F","G","A"`;
    const { song, mml } = conv(t);
    expect(notes(song).map((n) => [n.channel + 1, n.pitch])).toEqual([
      [1, 60],
      [2, 62],
      [3, 64],
      [4, 65],
      [5, 67],
      [6, 69],
      [10, 36],
    ]);
    expect(mml).toContain('初期音色: CALL VOICE @16 Vibraphone → @12 Vibraphone');
    expect(mml).toContain('// @33 Wood Bass → @33 Acoustic Bass');
    // mode 0: 4 melody strings, no rhythm; then PSG
    const m0 = conv('10 CALL MUSIC(0,0,1,1,1,1)\n20 PLAY #2,"C","D","E","F","G"');
    expect(notes(m0.song).map((n) => n.channel + 1)).toEqual([1, 2, 3, 4, 5]);
    expect(conv('10 PLAY #2,"C"').codes).toContain('W_MSX_NO_CALL_MUSIC');
  });

  it('L108 FM rhythm: letters sound together, a number waits; ! accents', () => {
    const { song } = conv('10 CALL MUSIC\n20 PLAY #2,"","","","V8@A15BH8H8S!8BSH4"');
    expect(notes(song, 10).map((n) => [n.pitch, n.startTick, n.velocity])).toEqual([
      [36, 0, 68],
      [42, 0, 68],
      [42, 240, 68],
      [38, 480, 127],
      [36, 720, 68],
      [38, 720, 68],
      [42, 720, 68],
    ]);
  });

  it('L109 X A$; runs a string variable, =V; inserts a number', () => {
    expect(pitches('10 A$="DE":B$="CXA$;":N=5\n20 PLAY "XB$;O=N;C"')).toEqual([60, 62, 64, 72]);
    expect(err('10 PLAY "XZ$;"')?.code).toBe('E_MSX_X');
  });

  it('L110 PLAY #1 (MSX-MIDI): @n is the GM program n + 1', () => {
    const { song, codes } = conv('10 CALL MUSIC\n20 PLAY #1,"@40C"');
    expect(song.tracks[0].events.find((e) => e.kind === 'program')).toMatchObject({ program: 40 });
    expect(codes).toContain('W_MSX_MIDI');
  });
});

describe('PC-8801 N88-BASIC L111–L114', () => {
  it('L111 CMD PLAY (#2): channels 1-3 FM, 4-6 SSG keep their numbers; N88 voices', () => {
    const { song, mml } = conv('10 CMD PLAY "@13C",,,"D",,"E"', 'pc88-basic');
    expect(notes(song).map((n) => [n.channel + 1, n.pitch])).toEqual([
      [1, 60],
      [4, 62],
      [6, 64],
    ]);
    expect(mml).toContain('// @13 PIANO → @1 Acoustic Grand Piano');
    expect(mml).toContain('チャンネル4（SSG）');
  });

  it('L112 CMD PLAY #0 (all SSG) / #5 (all FM) / #3 is an error; PLAY works as well', () => {
    expect(conv('10 CMD PLAY #0,"C","D","E","F"', 'pc88-basic').mml).toContain('チャンネル4（SSG）');
    expect(conv('10 CMD PLAY #5,"C","D","E","F"', 'pc88-basic').mml).toContain('チャンネル4（FM）');
    expect(err('10 CMD PLAY #3,"C"', 'pc88-basic')?.code).toBe('E_PC88_DEVICE');
    expect(pitches('10 PLAY "CD"', 1, 'pc88-basic')).toEqual([60, 62]);
  });

  it('L113 dialect guess', () => {
    expect(guessDialect('10 A$="CDE"\n20 CMD PLAY A$')).toBe('pc88-basic');
    expect(guessDialect('10 CALL MUSIC\n20 PLAY #2,"CDE"')).toBe('msx-basic');
    expect(guessDialect('10 _MUSIC:PLAY#2,"C"')).toBe('msx-basic');
    expect(guessDialect('10 "CDE","EFG"\n20 "C"')).toBe('pc98-play');
  });

  it('L114 a complete program recompiles and matches; the title comes from the first REM', () => {
    const { r } = conv(
      `10 ' テスト曲
20 DIM M$(3)
30 FOR I=1 TO 3:READ M$(I):NEXT
40 T$="T132":CMD PLAY T$+M$(1),M$(2),M$(3),"V10O5L8CEGECEGE"
50 CMD PLAY "{CDE}4F2","O3C1","@4O2C1"
60 DATA "@13O4L8CDEFGFED","@21O3L4CEGE","@4O2L2CG"`,
      'pc88-basic',
    );
    expect(r.ok && r.summary.verified).toBe(true);
    expect(r.ok && r.mml).toContain('PC-8801 N88-BASIC PLAY から変換: テスト曲');
  });
});
