// SPEC 8 Phase 6b acceptance tests L62–L79: picosakura (Sakura MML / Japanese MML) -> MML Studio MML.
// All inputs are self-made.
import { describe, expect, it } from 'vitest';
import { compileMml, type CompiledSong, type ControlEvent, type NoteEvent, type PitchBendEvent } from '../../src/engine';
import { convertDialect, guessDialect } from '../../src/engine/dialects';

function conv(text: string) {
  const r = convertDialect(text, 'sakura');
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}:${e.column} ${e.code} ${e.message}`).join('\n'));
  const c = compileMml(r.mml);
  if (!c.ok) throw new Error(`recompile failed\n${r.mml}`);
  return { r, song: c.song, mml: r.mml };
}
const notes = (s: CompiledSong) =>
  s.tracks
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note')
    .sort((a, b) => a.channel - b.channel || a.startTick - b.startTick || a.pitch - b.pitch);
const pitches = (text: string) => notes(conv(text).song).map((n) => n.pitch);
const durations = (text: string) => notes(conv(text).song).map((n) => n.durationTicks);
const err = (text: string) => {
  const r = convertDialect(text, 'sakura');
  expect(r.ok, text).toBe(false);
  return r.ok ? null : r.errors[0];
};

describe('picosakura acceptance L62–L79', () => {
  it('L62 octave: Sakura o5c = MIDI 60 (MML Studio o4c); the initial octave is 5', () => {
    expect(pitches('o5 cde')).toEqual([60, 62, 64]);
    expect(pitches('o4 c')).toEqual([48]);
    expect(pitches('c')).toEqual([60]);
    expect(conv('o5 c').mml).toContain('o4 c');
  });

  it('L63 lengths: default, explicit, double dot, %steps, ^, bare ^, 8+2', () => {
    expect(durations('l8 c c4 c.. c%96 c4^8 c^ c8+2')).toEqual([240, 480, 420, 480, 720, 480, 1200]);
  });

  it('L64 track forms: TR 1 / TR=2 / Track(3) / トラック４ -> 4 tracks on channels 1..4', () => {
    const { song } = conv('TR 1 c TR=2 d Track(3) e トラック４ f');
    expect(song.tracks.map((t) => t.channel)).toEqual([0, 1, 2, 3]);
    expect(notes(song).map((n) => [n.channel, n.pitch, n.startTick])).toEqual([
      [0, 60, 0],
      [1, 62, 0],
      [2, 64, 0],
      [3, 65, 0],
    ]);
  });

  it('L65 two Sakura tracks on the same channel are merged into one TR', () => {
    const { song, mml } = conv('TR(1) CH(1) c TR(2) CH(1) e');
    expect(song.tracks).toHaveLength(1);
    expect(notes(song).map((n) => [n.pitch, n.startTick])).toEqual([
      [60, 0],
      [64, 0],
    ]);
    expect(mml).toContain('Time(1:1:0)');
    expect(mml).toContain('サクラのトラック 1, 2');
  });

  it("L66 chords: 'o4 c o5 c e g'4 and 'c>e<g'8 (outer octave unchanged)", () => {
    // chord at tick 0, then c with the unchanged outer octave (o5) at tick 480
    expect(pitches("'o4 c o5 c e g'4 c")).toEqual([48, 60, 64, 67, 60]);
    const s = notes(conv("'c>e<g'8 d").song);
    expect(s.map((n) => [n.pitch, n.startTick])).toEqual([
      [60, 0],
      [67, 0],
      [76, 0],
      [62, 240],
    ]);
  });

  it('L67 one-shot octave marks ` and "', () => {
    expect(pitches('`c "c c')).toEqual([72, 48, 60]);
  });

  it('L68 relative velocity, step gate, per-note parameters', () => {
    const n = notes(conv('v100 v++ ) ( ( q%48 c c4,50,90 c').song);
    expect(n.map((x) => [x.velocity, x.gateTicks])).toEqual([
      [100, 240],
      [90, 240],
      [100, 240],
    ]);
  });

  it('L69 loops [3 cd:e] f and nested [2 [2 c] d]', () => {
    expect(pitches('l8 [3 cd:e] f').map((p) => p - 60)).toEqual([0, 2, 4, 0, 2, 4, 0, 2, 5]);
    expect(pitches('l8 [2 [2 c] d]').map((p) => p - 60)).toEqual([0, 0, 2, 0, 0, 2]);
  });

  it('L70 macros, Str and Int constants', () => {
    expect(pitches('#A={cde} #A #A').map((p) => p - 60)).toEqual([0, 2, 4, 0, 2, 4]);
    expect(pitches('Str S={ga} S').map((p) => p - 60)).toEqual([7, 9]);
    const { song } = conv('Int N=5 @N c');
    expect(song.tracks[0].events.find((e) => e.kind === 'program')).toMatchObject({ program: 4 });
  });

  it('L71 tempo forms and placement', () => {
    expect(conv('Tempo=90 c').song.tempoMap.map((t) => t.bpm)).toEqual([90]);
    expect(conv('Tempo={120.5} c').song.tempoMap.map((t) => t.microsecondsPerQuarter)).toEqual([497925]);
    const s = conv('TR 1 c1 Tempo=100 c TR 2 c2 Tempo(80) c').song;
    expect(s.tempoMap.map((t) => [t.tick, t.bpm])).toEqual([
      [0, 120],
      [960, 80],
      [1920, 100],
    ]);
  });

  it('L72 Time with a time signature', () => {
    expect(notes(conv('TimeSignature(3,4) Time(3:1:0) c').song).map((n) => n.startTick)).toEqual([2880]);
    expect(notes(conv('Time(2:3:48) c').song).map((n) => n.startTick)).toEqual([1920 + 960 + 240]);
  });

  it('L73 controllers: y / P / V / p / BR', () => {
    const ev = conv('y64,127 P(32) V(100) p80 BR(12) c').song.tracks[0].events;
    expect(ev.filter((e): e is ControlEvent => e.kind === 'cc').map((e) => [e.controller, e.value])).toEqual([
      [64, 127],
      [10, 32],
      [7, 100],
      [101, 0],
      [100, 0],
      [6, 12],
    ]);
    expect(ev.find((e): e is PitchBendEvent => e.kind === 'pitchbend')?.value).toBe(2048);
  });

  it('L74 Key and TrackKey transpose', () => {
    expect(pitches('Key(2) c TrackKey(-1) d')).toEqual([62, 63]);
  });

  it('L75 rhythm mode and $ macros', () => {
    expect(pitches('TR(10) Rhythm{ b8 h8 s8 h8 }').sort((a, b) => a - b)).toEqual([36, 38, 42, 42]);
    const { song } = conv('TR(10) $x{n37,} Rhythm{ x8 x8 }');
    expect(notes(song).map((n) => [n.channel, n.pitch, n.durationTicks])).toEqual([
      [9, 37, 240],
      [9, 37, 240],
    ]);
  });

  it('L76 Japanese MML equals the English MML', () => {
    const ja = notes(conv('音階５ ドレミファー ソッ「ドミソ」４ テンポ１２０ トラック２ ペダル 放す ド').song).map((n) => [n.channel, n.pitch, n.startTick, n.durationTicks]);
    const en = notes(conv("o5 cdef^ gr'ceg'4 Tempo=120 Track=2 y64,127; y64,0; c").song).map((n) => [n.channel, n.pitch, n.startTick, n.durationTicks]);
    expect(ja).toEqual(en);
    expect(ja[3]).toEqual([0, 65, 1440, 960]);
  });

  it('L77 comments are removed; strings are not rewritten', () => {
    const { mml, song } = conv('// ドレミ\n/* ソラシ */\n## x\n# y\n#- z\nTrackName={"ドレミの歌"} c');
    expect(notes(song)).toHaveLength(1);
    expect(mml).toContain('picosakura から変換: ドレミの歌');
  });

  it('L78 programming features are rejected with a position and the MIDI hint', () => {
    for (const t of ['Int I=3+1 c', 'For(Int I=0; I<3; I++){ c }', 'Play(A)', 'Int X=Random(1,6)', 'Include(x.h)', 'IF(1){c}']) {
      const e = err(t);
      expect(e?.code, t).toBe('E_SAKURA_UNSUPPORTED');
      expect(e?.message).toContain('MIDI');
      expect(e?.line).toBe(1);
    }
    expect(err('c\n  Print(X)')).toMatchObject({ line: 2, column: 3 });
  });

  it('L79 every conversion recompiles and matches (a mixed piece)', () => {
    const { r } = conv(`TrackName={"総合テスト"}
Tempo=132 TimeSignature(4,4)
#R={c8d8e8}
TR 1 @1 v90 q90 l8 o5 [2 #R f4:g4] a2 'o4 c o5 c e'4 c4^8 Sub{ >c4 } r4 y64,127 d2 y64,0
TR 2 CH(2) @33 o3 l4 c c8+8 {cde}4 g2 p80 c p64
TR 3 CH(10) Rhythm{ [2 b8h8s8h8] }
TR 4 CH(1) Time(3:1:0) o4 g1`);
    expect(r.ok && r.summary.verified).toBe(true);
  });
});

describe('picosakura extras', () => {
  it('& ties the same pitch; a different pitch becomes legato', () => {
    const n = notes(conv('q50 c&c d&e').song);
    expect(n.map((x) => [x.pitch, x.durationTicks, x.gateTicks])).toEqual([
      [60, 960, 480],
      [62, 480, 480],
      [64, 480, 240],
    ]);
  });

  it('@(name) matches a GM name; unknown names are errors', () => {
    expect(conv('@(Marimba) c').song.tracks[0].events.find((e) => e.kind === 'program')).toMatchObject({ program: 12 });
    expect(err('@(NoSuchVoice) c')?.code).toBe('E_SAKURA_VOICE');
  });

  it('MeasureShift(1) + Time(1:1:0) + TrackSync starts the song at measure 2', () => {
    expect(notes(conv('System.MeasureShift(1);ResetGM;Time(1:1:0);TrackSync; c').song)[0].startTick).toBe(1920);
    expect(notes(conv('音源初期化 ド').song)[0].startTick).toBe(1920);
  });

  it('overlapping same pitches on one channel fall back to exact ticks', () => {
    const { r, song } = conv('TR(1) CH(1) c2 TR(2) CH(1) r4 c2');
    expect(r.ok && r.warnings.map((w) => w.code)).toContain('W_SAKURA_OVERLAP');
    expect(notes(song).map((n) => [n.startTick, n.startTick + n.gateTicks])).toEqual([
      [0, 480], // trimmed so that the next C can start
      [480, 1248], // q80 of a half note
    ]);
  });

  it('unknown commands / characters are errors with positions', () => {
    expect(err('c Foo(1)')).toMatchObject({ code: 'E_SAKURA_UNKNOWN', column: 3 });
    expect(err('c $')?.code).toBe('E_SAKURA_CHAR');
    expect(err('c 漢')).toMatchObject({ code: 'E_SAKURA_CHAR', column: 3 });
  });

  it('timing / time-varying commands are warned, not fatal', () => {
    const r = convertDialect('t-2 v.onTime(10,100,!1) c EP.W(1,2,!4) d', 'sakura');
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['W_SAKURA_TIMING', 'W_SAKURA_TIMED']));
  });

  it('the earlier hand-written chord MML converts (TR 1, o inside chords, 8+2)', () => {
    const { song } = conv(`TR 1 o5
c8 <b8 >c8 d4 c4 c8
TR 2
'o3 c o4 c e g'1
'o3 g o4 g b d f'8+2`);
    expect(notes(song).filter((n) => n.channel === 1).map((n) => [n.pitch, n.startTick, n.durationTicks])).toEqual([
      [36, 0, 1920],
      [48, 0, 1920],
      [52, 0, 1920],
      [55, 0, 1920],
      [43, 1920, 1200],
      [50, 1920, 1200],
      [53, 1920, 1200],
      [55, 1920, 1200],
      [59, 1920, 1200],
    ]);
  });

  it('dialect guess', () => {
    expect(guessDialect('TR 1 o5 cde')).toBe('sakura');
    expect(guessDialect('ドレミ')).toBe('sakura');
    expect(guessDialect('10 "CDE"')).toBe('pc98-play');
    expect(guessDialect('Tempo=102\nTR(1) Time(1:1:0); @47 cde')).toBe('sakura');
    expect(guessDialect('TR(1) CH(1) @1 o4 cde')).toBeNull(); // MML Studio itself
  });
});
