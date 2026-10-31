// Additional boundary / musical edge tests (SPEC 8 "追加で以下をテストする" 2, 3).
import { describe, expect, it } from 'vitest';
import { compileMml, LIMITS, secondsToTicks, ticksToSeconds, type CompiledSong, type NoteEvent } from '../../src/engine';

function ok(src: string): CompiledSong {
  const r = compileMml(src);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
  return r.song;
}
function codes(src: string): string[] {
  const r = compileMml(src);
  return r.ok ? [] : r.diagnostics.map((d) => d.code);
}
const notes = (s: CompiledSong) => s.tracks.flatMap((t) => t.events).filter((e): e is NoteEvent => e.kind === 'note');

describe('lexical boundaries', () => {
  it('empty source compiles with no notes and default tempo', () => {
    const s = ok('');
    expect(s.tracks).toEqual([]);
    expect(s.endTick).toBe(0);
    expect(s.tempoMap).toEqual([{ kind: 'tempo', tick: 0, bpm: 120, microsecondsPerQuarter: 500000 }]);
  });

  it('trailing line comment without newline', () => {
    expect(notes(ok('c4 // end'))).toHaveLength(1);
  });

  it('CRLF line endings and semicolons', () => {
    const s = ok('o4 c4;\r\nd4;e4');
    expect(notes(s).map((n) => n.pitch)).toEqual([60, 62, 64]);
  });

  it('unterminated block comment is an error with position', () => {
    const r = compileMml('c4\n  /* oops');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0].code).toBe('E_UNTERMINATED_COMMENT');
      expect(r.diagnostics[0].span.startLine).toBe(2);
      expect(r.diagnostics[0].span.startColumn).toBe(3);
    }
  });

  it('Unicode inside comments is fine, outside is an error', () => {
    expect(notes(ok('// ドレミ 🎵\nc /* 和音 */ d'))).toHaveLength(2);
    const r = compileMml('c ド d');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0].code).toBe('E_INVALID_CHAR');
      expect(r.diagnostics[0].span.startColumn).toBe(3);
    }
  });

  it('unknown characters / commands are errors', () => {
    expect(codes('c4 x d4')).toEqual(['E_UNKNOWN_COMMAND']);
    expect(codes('c4 $ d4')).toEqual(['E_INVALID_CHAR']);
  });

  it('commands are case-insensitive', () => {
    const s = ok('TRACK(1) CHANNEL(2) TEMPO(90) O5 L8 V90 Q50 C D');
    expect(notes(s).map((n) => [n.pitch, n.durationTicks, n.gateTicks, n.velocity, n.channel])).toEqual([
      [72, 240, 120, 90, 1],
      [74, 240, 120, 90, 1],
    ]);
    expect(s.tempoMap[0].bpm).toBe(90);
  });

  it('longest match: TR(1) is not t + r, cc is two notes, TR=2 and CH=3 forms', () => {
    const s = ok('TR(1) cc TR=2 CH=3 e');
    expect(notes(s).map((n) => [n.track, n.channel, n.pitch])).toEqual([
      [1, 0, 60],
      [1, 0, 60],
      [2, 2, 64],
    ]);
  });

  it('lengths must be attached to the note', () => {
    expect(codes('c 4')).toEqual(['E_UNEXPECTED_NUMBER']);
  });

  it('only one accidental and one dot', () => {
    expect(codes('c++')).toEqual(['E_ACCIDENTAL']);
    expect(codes('c4..')).toEqual(['E_DOT']);
  });

  it('unsupported syntax is reported, not ignored', () => {
    expect(codes('[c d]2')).toContain('E_UNSUPPORTED');
    expect(codes('{c d e}4')).toContain('E_UNSUPPORTED');
  });

  it('missing values are errors', () => {
    expect(codes('o')).toEqual(['E_MISSING_VALUE']);
    expect(codes('t')).toEqual(['E_MISSING_VALUE']);
    expect(codes('TR()')).toEqual(['E_MISSING_VALUE']);
    expect(codes('TR(1')).toEqual(['E_SYNTAX']);
  });
});

describe('ranges and limits', () => {
  it('pitch out of MIDI range', () => {
    expect(codes('o9 b')).toEqual(['E_PITCH_RANGE']);
    expect(notes(ok('o0 c-')).map((n) => n.pitch)).toEqual([11]);
    expect(notes(ok('o9 g')).map((n) => n.pitch)).toEqual([127]);
    expect(notes(ok('o0 c')).map((n) => n.pitch)).toEqual([12]);
    expect(notes(ok('n0 n127')).map((n) => n.pitch)).toEqual([0, 127]);
    expect(codes('n128')).toEqual(['E_RANGE']);
  });

  it('octave shift out of range', () => {
    expect(codes('o9 >c')).toEqual(['E_RANGE']);
    expect(codes('o0 <c')).toEqual(['E_RANGE']);
  });

  it('tempo, channel, track ranges', () => {
    expect(codes('t19')).toEqual(['E_RANGE']);
    expect(codes('t301')).toEqual(['E_RANGE']);
    expect(notes(ok('t20 c t300 c'))).toHaveLength(2);
    expect(codes('CH(0)')).toEqual(['E_RANGE']);
    expect(codes('CH(17)')).toEqual(['E_RANGE']);
    expect(codes('TR(33) c')).toEqual(['E_RANGE']);
  });

  it('too many notes', () => {
    const src = 'l64 q1 ' + 'c'.repeat(LIMITS.maxNotes + 1);
    expect(codes(src)).toEqual(['E_LIMIT']);
  });

  it('song too long', () => {
    // 1042 whole notes = 2,000,640 ticks > 2,000,000
    expect(codes('r1'.repeat(1042))).toEqual(['E_LIMIT']);
    expect(ok('r1'.repeat(1041)).endTick).toBe(1041 * 1920);
  });

  it('source too large', () => {
    expect(codes('r'.repeat(LIMITS.maxSourceBytes + 1))).toEqual(['E_LIMIT']);
  });

  it('track 16..32 needs an explicit channel; 32 tracks max', () => {
    expect(codes('TR(16) c')).toEqual(['E_CHANNEL_REQUIRED']);
    expect(notes(ok('TR(16) CH(16) c'))[0].channel).toBe(15);
    expect(codes('TR(32) @5')).toEqual(['E_CHANNEL_REQUIRED']);
  });

  it('rests do not need a channel', () => {
    expect(ok('TR(20) r4').endTick).toBe(480);
  });
});

describe('musical boundaries', () => {
  it('same tick note-off then note-on is allowed (repeated note)', () => {
    expect(notes(ok('q100 c4 c4')).map((n) => [n.startTick, n.gateTicks])).toEqual([
      [0, 480],
      [480, 480],
    ]);
  });

  it('dotted lengths and ties combine', () => {
    expect(notes(ok('c4.^8&c16')).map((n) => n.durationTicks)).toEqual([720 + 240 + 120]);
    expect(notes(ok('l8. c&c')).map((n) => n.durationTicks)).toEqual([720]);
  });

  it('tie keeps the first velocity and gate', () => {
    expect(notes(ok('v80 q50 c4&c4')).map((n) => [n.velocity, n.gateTicks])).toEqual([[80, 480]]);
  });

  it('tie across rest / track switch is an error', () => {
    expect(codes('c4&r4')).toEqual(['E_TIE']);
    expect(codes('c4&TR(2)c4')).toEqual(['E_TIE']);
    expect(codes('c4^')).toEqual(['E_TIE']);
  });

  it('tie compares absolute pitch across enharmonics', () => {
    expect(notes(ok('c+4&d-4')).map((n) => [n.pitch, n.durationTicks])).toEqual([[61, 960]]);
  });

  it('v0 is silent but advances time', () => {
    const s = ok('v0 c4 v100 d4');
    expect(notes(s).map((n) => [n.pitch, n.startTick])).toEqual([[62, 480]]);
  });

  it('minimum gate is 1 tick when q > 0', () => {
    expect(notes(ok('q1 c64')).map((n) => n.gateTicks)).toEqual([1]);
  });

  it('tempo right after a change and integration', () => {
    const s = ok('t120 c4 t60 c4 t240 c4');
    expect(ticksToSeconds(480, s.tempoMap)).toBeCloseTo(0.5);
    expect(ticksToSeconds(960, s.tempoMap)).toBeCloseTo(1.5);
    expect(ticksToSeconds(1440, s.tempoMap)).toBeCloseTo(1.75);
    expect(secondsToTicks(1.5, s.tempoMap)).toBeCloseTo(960);
    expect(secondsToTicks(1.0, s.tempoMap)).toBeCloseTo(720);
  });

  it('same tempo at the same tick is merged; explicit tick0 tempo replaces default', () => {
    const s = ok('TR(1) t90 TR(2) t90');
    expect(s.tempoMap.map((t) => [t.tick, t.bpm])).toEqual([[0, 90]]);
  });

  it('Tempo() and t are equivalent and conflict detection uses μs', () => {
    expect(codes('TR(1) Tempo(120) TR(2) t121')).toEqual(['E_TEMPO_CONFLICT']);
  });

  it('TR round trip keeps per-track state', () => {
    const s = ok('TR(1) o5 l8 v90 q50 @20 c TR(2) d TR(1) d');
    const t1 = notes(s).filter((n) => n.track === 1);
    expect(t1.map((n) => [n.pitch, n.startTick, n.durationTicks, n.velocity, n.gateTicks])).toEqual([
      [72, 0, 240, 90, 120],
      [74, 240, 240, 90, 120],
    ]);
    const t2 = notes(s).filter((n) => n.track === 2);
    expect(t2.map((n) => [n.pitch, n.durationTicks, n.velocity])).toEqual([[62, 480, 100]]);
  });

  it('drum channel: CH(10) maps to MIDI channel 9 and rejects @', () => {
    expect(notes(ok('TR(3) CH(10) n36'))[0].channel).toBe(9);
    expect(codes('TR(3) CH(10) @1 n36')).toEqual(['E_DRUM_PROGRAM']);
  });

  it('CH cannot change after the first performance event', () => {
    expect(codes('TR(1) c CH(2) d')).toEqual(['E_CHANNEL_LOCKED']);
    expect(codes('TR(1) @5 CH(2)')).toEqual(['E_CHANNEL_LOCKED']);
    expect(notes(ok('TR(1) r4 CH(2) c'))[0].channel).toBe(1);
  });

  it('implicit default channel conflicts with an explicit CH on another track', () => {
    expect(codes('TR(1) CH(2) c TR(2) e')).toEqual(['E_CHANNEL_CONFLICT']);
  });

  it('sequential same-pitch notes never overlap (overlap detection is exercised with Sub/Time in Phase 4)', () => {
    // Currently only constructible via ties of the same track; sequential notes never overlap.
    expect(codes('q100 c4 c4 c4')).toEqual([]);
  });
});
