// Mute / solo (SPEC 6.4): which MIDI channels are silenced.
import { describe, expect, it } from 'vitest';
import { compileMml } from '../../src/engine';
import { EMPTY_MIX, isSilenced, silencedChannels, toggleMute, toggleSolo } from '../../src/ui/mix';
import { rollFromSong } from '../../src/ui/roll-data';

const tracks = [
  { label: 'TR1', channel: 0 },
  { label: 'TR2', channel: 1 },
  { label: 'TR3', channel: 9 },
];

describe('mute / solo', () => {
  it('silences nothing by default', () => {
    expect(silencedChannels(tracks, EMPTY_MIX)).toEqual([]);
    expect(isSilenced(EMPTY_MIX, 'TR1')).toBe(false);
  });

  it('mutes the channel of a muted track, and unmutes on a second toggle', () => {
    const m = toggleMute(EMPTY_MIX, 'TR2');
    expect(silencedChannels(tracks, m)).toEqual([1]);
    expect(silencedChannels(tracks, toggleMute(m, 'TR2'))).toEqual([]);
  });

  it('solo silences every other channel (including channels without tracks)', () => {
    const s = toggleSolo(EMPTY_MIX, 'TR3');
    const silenced = silencedChannels(tracks, s);
    expect(silenced).not.toContain(9);
    expect(silenced).toHaveLength(15);
    expect(isSilenced(s, 'TR1')).toBe(true);
    expect(isSilenced(s, 'TR3')).toBe(false);
  });

  it('several solos add up; mute wins over solo', () => {
    let mix = toggleSolo(toggleSolo(EMPTY_MIX, 'TR1'), 'TR2');
    expect(silencedChannels(tracks, mix)).not.toContain(0);
    expect(silencedChannels(tracks, mix)).not.toContain(1);
    expect(silencedChannels(tracks, mix)).toContain(9);
    mix = toggleMute(mix, 'TR1');
    expect(silencedChannels(tracks, mix)).toContain(0);
    expect(silencedChannels(tracks, mix)).not.toContain(1);
  });

  it('ignores labels that are not in the song (kept across recompiles)', () => {
    expect(silencedChannels(tracks, toggleMute(EMPTY_MIX, 'TR9'))).toEqual([]);
  });

  it('uses the channels of the compiled MML tracks', () => {
    const c = compileMml('TR(1) CH(3) c4 TR(2) CH(10) n36');
    if (!c.ok) throw new Error('compile');
    const roll = rollFromSong(c.song);
    expect(silencedChannels(roll.tracks, toggleMute(EMPTY_MIX, 'TR2'))).toEqual([9]);
    expect(silencedChannels(roll.tracks, toggleSolo(EMPTY_MIX, 'TR2'))).toContain(2);
  });
});
