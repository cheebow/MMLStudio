// Public engine types (SPEC 4.1). The engine is pure TypeScript: no DOM, audio or React.

export const PPQ = 480 as const;

export type DiagnosticSeverity = 'error' | 'warning';

export interface SourceSpan {
  /** UTF-16 code unit offsets */
  startOffset: number;
  endOffset: number;
  /** 1-based */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  span: SourceSpan;
}

export interface NoteEvent {
  kind: 'note';
  track: number;
  /** 0-based MIDI channel */
  channel: number;
  pitch: number;
  velocity: number;
  startTick: number;
  durationTicks: number;
  gateTicks: number;
  source: SourceSpan;
}

export interface ProgramEvent {
  kind: 'program';
  track: number;
  channel: number;
  tick: number;
  /** 0..127 (MIDI value) */
  program: number;
  source: SourceSpan;
}

export interface TempoEvent {
  kind: 'tempo';
  tick: number;
  bpm: number;
  /** The exact SMF tempo value is the source of truth. */
  microsecondsPerQuarter: number;
  source?: SourceSpan;
}

export interface ControlEvent {
  kind: 'cc';
  track: number;
  channel: number;
  tick: number;
  controller: number;
  value: number;
  source: SourceSpan;
}

export interface PitchBendEvent {
  kind: 'pitchbend';
  track: number;
  channel: number;
  tick: number;
  /** -8192..8191, center = 0 */
  value: number;
  source: SourceSpan;
}

export type TrackEvent = NoteEvent | ProgramEvent | ControlEvent | PitchBendEvent;

export interface CompiledTrack {
  number: number;
  /** 0-based MIDI channel */
  channel: number;
  events: TrackEvent[];
}

export interface CompiledSong {
  ppq: typeof PPQ;
  tracks: CompiledTrack[];
  tempoMap: TempoEvent[];
  endTick: number;
  /** warnings only on success */
  diagnostics: Diagnostic[];
}

export type CompileResult =
  | { ok: true; song: CompiledSong; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Limits (SPEC 4.1) */
export const LIMITS = {
  maxSourceBytes: 2 * 1024 * 1024,
  maxNotes: 100_000,
  maxPerformanceTracks: 32,
  maxTicks: 2_000_000,
  maxDiagnostics: 200,
} as const;
