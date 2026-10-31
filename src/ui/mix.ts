// Mute / solo of the playback (SPEC 6.4). Pure functions (no DOM, no audio) so they can be tested.
// The choice is kept by track label (`TR1` for MML, `CH1` for the original MIDI) so it survives recompiles.

export interface Mix {
  muted: ReadonlySet<string>;
  soloed: ReadonlySet<string>;
}

export const EMPTY_MIX: Mix = { muted: new Set(), soloed: new Set() };

/** a track is silent when it is muted, or when some track is soloed and it is not */
export function isSilenced(mix: Mix, label: string): boolean {
  return mix.muted.has(label) || (mix.soloed.size > 0 && !mix.soloed.has(label));
}

/**
 * MIDI channels (0..15) to silence. While a solo is active every channel that no audible soloed track
 * uses is silenced (also channels without notes, so nothing unexpected can sound).
 */
export function silencedChannels(tracks: ReadonlyArray<{ label: string; channel: number }>, mix: Mix): number[] {
  const audible = new Set<number>();
  const silenced = new Set<number>();
  for (const t of tracks) (isSilenced(mix, t.label) ? silenced : audible).add(t.channel);
  if (mix.soloed.size > 0) for (let ch = 0; ch < 16; ch++) if (!audible.has(ch)) silenced.add(ch);
  // MML tracks have unique channels; for safety a channel that some audible track uses stays on.
  return [...silenced].filter((ch) => !audible.has(ch)).sort((a, b) => a - b);
}

function toggled(set: ReadonlySet<string>, label: string): Set<string> {
  const next = new Set(set);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  return next;
}

export const toggleMute = (mix: Mix, label: string): Mix => ({ ...mix, muted: toggled(mix.muted, label) });
export const toggleSolo = (mix: Mix, label: string): Mix => ({ ...mix, soloed: toggled(mix.soloed, label) });
