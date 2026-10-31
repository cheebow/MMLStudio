// Track list voice: the program at the first note, and the number of real changes afterwards.
import { describe, expect, it } from 'vitest';
import { compileMml } from '../../src/engine';
import { trackVoice } from '../../src/ui/track-voice';

const voice = (mml: string) => {
  const c = compileMml(mml);
  if (!c.ok) throw new Error(JSON.stringify(c.diagnostics));
  return trackVoice(c.song.tracks[0].events);
};

describe('track list voice', () => {
  it('a program set after a lead-in (before the first note) is the track voice', () => {
    expect(voice('TR(1) CH(1) Time(3:1:0) @12 Time(5:1:0) c')).toEqual({ program: 11, changes: 0 });
  });
  it('repeating the same program is not a change; a different one is', () => {
    expect(voice('TR(1) CH(1) @39 c @39 d @39 e @88 f @88 g')).toEqual({ program: 38, changes: 1 });
  });
  it('no program: @1; no notes: the first program', () => {
    expect(voice('TR(1) CH(1) c d')).toEqual({ program: 0, changes: 0 });
    expect(voice('TR(1) CH(1) @5 r @6 r')).toEqual({ program: 4, changes: 0 });
  });
  it('a program after the first note counts as a change', () => {
    expect(voice('TR(1) CH(1) c @20 d')).toEqual({ program: 0, changes: 1 });
  });
});
