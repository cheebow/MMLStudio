// Types for converting other MML dialects into MML Studio MML (SPEC 4.5.2).

export type DialectId = 'pc98-play' | 'pc88-basic' | 'msx-basic' | 'sakura';

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

/** `bestEffort`: skip what cannot be converted (with warnings) instead of failing (picosakura only). */
export interface DialectOptions {
  songIndex?: number;
  bestEffort?: boolean;
}

export type DialectConvertResult =
  | { ok: true; mml: string; warnings: DialectWarning[]; summary: { dialect: DialectId; parts: number; notes: number; verified: boolean; approximate?: boolean } }
  | { ok: false; errors: DialectWarning[] };
