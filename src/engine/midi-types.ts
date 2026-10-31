// Types for the MIDI -> MML import pipeline (SPEC 4.4). Pure data, no DOM.

export type ImportSeverity = 'error' | 'warning' | 'info';

/** A reader / converter message. Byte offsets refer to the original SMF. */
export interface ImportIssue {
  code: string;
  severity: ImportSeverity;
  message: string;
  /** 0-based MTrk index */
  track?: number;
  byteOffset?: number;
}

export type RawMidiEvent =
  | { type: 'noteOn'; tick: number; channel: number; pitch: number; velocity: number }
  /** `fromZeroVelocity`: encoded as Note On velocity 0 */
  | { type: 'noteOff'; tick: number; channel: number; pitch: number; velocity: number; fromZeroVelocity: boolean }
  | { type: 'cc'; tick: number; channel: number; controller: number; value: number }
  | { type: 'program'; tick: number; channel: number; program: number }
  /** -8192..8191 */
  | { type: 'pitchbend'; tick: number; channel: number; value: number }
  | { type: 'channelPressure'; tick: number; channel: number; value: number }
  | { type: 'polyPressure'; tick: number; channel: number; pitch: number; value: number }
  | { type: 'tempo'; tick: number; microsecondsPerQuarter: number }
  | { type: 'timeSignature'; tick: number; numerator: number; denominator: number }
  | { type: 'keySignature'; tick: number }
  | { type: 'trackName'; tick: number; text: string }
  /** other text-like meta events (text, copyright, lyric, marker, cue, ...) */
  | { type: 'text'; tick: number; metaType: number; text: string }
  | { type: 'otherMeta'; tick: number; metaType: number; length: number }
  | { type: 'sysex'; tick: number; length: number }
  | { type: 'endOfTrack'; tick: number };

export interface ParsedTrack {
  /** 0-based MTrk index */
  index: number;
  name?: string;
  /** In original ticks, in file order. */
  events: RawMidiEvent[];
  endTick: number;
}

export interface ParsedMidi {
  format: 0 | 1;
  /** Original ticks per quarter note */
  ppq: number;
  tracks: ParsedTrack[];
  byteLength: number;
  eventCount: number;
  noteOnCount: number;
  warnings: ImportIssue[];
}

export type MidiReadResult = { ok: true; midi: ParsedMidi } | { ok: false; errors: ImportIssue[] };

export const MIDI_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxEvents: 300_000,
  maxNoteOns: 100_000,
} as const;

/** Normalised (480 PPQ, per channel) representation used for MML generation and comparison. */
export interface CanonNote {
  /** 0-based */
  channel: number;
  pitch: number;
  velocity: number;
  startTick: number;
  /** actual Note Off tick (exclusive) */
  endTick: number;
}

export type CanonControl =
  | { kind: 'program'; channel: number; tick: number; program: number }
  | { kind: 'cc'; channel: number; tick: number; controller: number; value: number }
  | { kind: 'pitchbend'; channel: number; tick: number; value: number };

export interface CanonTempo {
  tick: number;
  microsecondsPerQuarter: number;
}

export interface CanonChannel {
  /** 0-based */
  channel: number;
  notes: CanonNote[];
  /** in original stream order */
  controls: CanonControl[];
  /** MTrk indices that contributed events */
  sourceTracks: number[];
}

export interface CanonSong {
  channels: CanonChannel[];
  tempos: CanonTempo[];
  endTick: number;
}

export interface NormalizeStats {
  originalFormat: 0 | 1;
  originalPpq: number;
  sourceTracks: number;
  noteCount: number;
  /** max |exact - rounded| over all converted event ticks, in 480-PPQ ticks */
  roundingMaxErrorTicks: number;
  /** event kind -> number of events that cannot be represented in MML */
  lostEvents: Record<string, number>;
}

export interface NormalizedMidi {
  song: CanonSong;
  stats: NormalizeStats;
  trackNames: Map<number, string>;
  warnings: ImportIssue[];
}

export type QuantizeGrid = '1/8' | '1/16' | '1/32';

export interface MidiImportOptions {
  mode: 'fidelity' | 'readable';
  /** readable mode only; default 1/16 */
  quantize?: QuantizeGrid;
  /** Source file name, used only in the generated header comment. */
  fileName?: string;
}

export interface RoundTripReport {
  ok: boolean;
  compared: { notes: number; tempos: number; programs: number; cc: number; pitchbend: number };
  mismatchCount: number;
  /** first few human-readable mismatches */
  mismatches: string[];
}

export interface QuantizeReport {
  grid: number;
  notesMoved: number;
  notesResized: number;
  maxStartShift: number;
  maxEndShift: number;
  controlsMoved: number;
  temposMoved: number;
  /** channels written in fidelity form because quantisation would collide */
  fallbackChannels: number[];
}

export interface MidiImportSummary {
  originalFormat: 0 | 1;
  originalPpq: number;
  sourceTracks: number;
  sourceChannels: number;
  noteCount: number;
  roundingMaxErrorTicks: number;
  warnings: string[];
  mode: 'fidelity' | 'readable';
  lostEvents: Record<string, number>;
  /** MML recompiled and compared with the expected events */
  roundTrip: RoundTripReport;
  /** readable mode: differences from the original (fidelity) events */
  quantize?: QuantizeReport;
  mmlBytes: number;
  /** length of the original song in seconds (from the normalised tempo map) */
  originalDurationSeconds: number;
}

export type MidiImportResult =
  | { ok: true; mml: string; summary: MidiImportSummary; originalSmf: Uint8Array }
  | {
      ok: false;
      issues: ImportIssue[];
      originalSmf?: Uint8Array;
      /** true when the file itself was read correctly (direct playback of the original is possible) */
      originalPlayable: boolean;
    };
