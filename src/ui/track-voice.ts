import type { NoteEvent, ProgramEvent, TrackEvent } from '../engine';

/**
 * Voice shown in the track list: the program in effect when the first note sounds
 * (a song may set its programs after a lead-in, e.g. at Time(3:1:0)), and how many times
 * it changes to a different program afterwards. Repeating the same program is not a change.
 * Without notes, the first program is shown.
 */
export function trackVoice(events: TrackEvent[]): { program: number; changes: number } {
  const programs = events.filter((e): e is ProgramEvent => e.kind === 'program').sort((a, b) => a.tick - b.tick);
  const notes = events.filter((e): e is NoteEvent => e.kind === 'note');
  if (notes.length === 0) return { program: programs[0]?.program ?? 0, changes: 0 };
  const firstNote = Math.min(...notes.map((n) => n.startTick));
  let program = 0;
  let current = 0;
  let changes = 0;
  for (const p of programs) {
    if (p.tick <= firstNote) {
      program = p.program;
      current = p.program;
    } else if (p.program !== current) {
      changes++;
      current = p.program;
    }
  }
  return { program, changes };
}
