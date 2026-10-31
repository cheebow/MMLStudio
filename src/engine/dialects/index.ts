// Other MML dialects -> MML Studio MML (SPEC 4.5). The MML Studio language itself is unchanged.
import { utf8Length } from '../source';
import { LIMITS } from '../types';
import { convertPc98Play, listPc98Songs } from './pc98-play';
import type { DialectConvertResult, DialectId, DialectSong } from './types';

export * from './types';
export { FM_VOICES, SSG_DEFAULT_GM, type FmVoice } from './fm-voices';

export const DIALECTS: ReadonlyArray<{ id: DialectId; label: string }> = [{ id: 'pc98-play', label: 'PC-9801 PLAY 文（行番号 "…","…" 形式）' }];

export function listDialectSongs(text: string, dialect: DialectId): DialectSong[] {
  switch (dialect) {
    case 'pc98-play':
      return listPc98Songs(text);
  }
}

export function convertDialect(text: string, dialect: DialectId, options: { songIndex?: number } = {}): DialectConvertResult {
  if (utf8Length(text) > LIMITS.maxSourceBytes) {
    return { ok: false, errors: [{ code: 'E_DIALECT_TOO_LARGE', message: `入力が大きすぎます（上限 ${LIMITS.maxSourceBytes / 1024 / 1024} MiB）。`, line: 1, column: 1 }] };
  }
  let result: DialectConvertResult;
  switch (dialect) {
    case 'pc98-play':
      result = convertPc98Play(text, options.songIndex ?? 0);
      break;
  }
  if (result.ok && utf8Length(result.mml) > LIMITS.maxSourceBytes) {
    return { ok: false, errors: [{ code: 'E_DIALECT_TOO_LARGE', message: '変換結果の MML が 2 MiB を超えます。', line: 1, column: 1 }] };
  }
  return result;
}

/** Suggests a dialect for pasted text (the user confirms; SPEC 4.5.6). */
export function guessDialect(text: string): DialectId | null {
  return /^\s*\d+\s+(?:PLAY\s*)?"/im.test(text) ? 'pc98-play' : null;
}
