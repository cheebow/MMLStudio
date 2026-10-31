// Types for converting other MML dialects into MML Studio MML (SPEC 4.5.2).

export type DialectId = 'pc98-play';

export interface DialectSong {
  index: number;
  title?: string;
  /** 1-based line where the song starts */
  startLine: number;
  parts: number;
}

/** Positions refer to the pasted dialect text (1-based). */
export interface DialectWarning {
  code: string;
  message: string;
  line: number;
  column: number;
  /** number of occurrences (warnings are aggregated; the position is the first one) */
  count?: number;
}

export type DialectConvertResult =
  | { ok: true; mml: string; warnings: DialectWarning[]; summary: { dialect: DialectId; parts: number; notes: number; verified: boolean } }
  | { ok: false; errors: DialectWarning[] };
