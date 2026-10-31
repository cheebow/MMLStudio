// PC-9801 PLAY statement (line-numbered format) -> MML Studio MML (SPEC 4.5.3 - 4.5.5).
// Hand-written. The MML interpretation and the writer are shared with PC-8801 / MSX (play-core.ts).
import { FM_VOICES, SSG_DEFAULT_GM } from './fm-voices';
import { convertPlayParts, PlayError, playErr, PlayWarnings, type PlayProfile, type Segment } from './play-core';
import type { DialectConvertResult, DialectSong } from './types';

const MAX_PARTS = 6;

/** N88-BASIC FM voices (shared by PC-9801 and PC-8801) */
export const N88_PROFILE_BASE = {
  fmVoice: (n: number) => FM_VOICES[n],
  fmVoiceMax: 81,
  psgVoice: { name: 'SSG', gm: SSG_DEFAULT_GM.gm, gmName: SSG_DEFAULT_GM.gmName },
  psgLabel: 'SSG',
  psgAcceptsVoice: true,
  note: '音色は GM の近い音色に置き換えています。SSG のエンベロープ等は再現しません。',
} as const;

const PROFILE: PlayProfile = { ...N88_PROFILE_BASE, dialect: 'pc98-play', label: 'PC-9801 PLAY' };

/* ------------------------------------------------------------------ input lines */

interface ParsedSong {
  title?: string;
  startLine: number;
  /** parts[i] = segments of part i in line order */
  parts: Segment[][];
}


const HEADER = /^\s*"([^"]*)"\s*,\s*"([^"]*)"\s*(?:,\s*-?\d+\s*)*$/;
const DATA = /^(\s*)(\d+)(\s+)(?:(PLAY)(\s*))?/i;

/** Splits `"a","b",...` starting at `start`; returns strings with their 1-based columns. */
function quotedList(text: string, start: number, lineNo: number): Array<{ value: string; column: number }> {
  const out: Array<{ value: string; column: number }> = [];
  let i = start;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] !== '"') playErr('E_DIALECT_LINE', `引用符 " で囲んだ演奏データが必要です。`, lineNo, i + 1);
    const close = text.indexOf('"', i + 1);
    if (close < 0) playErr('E_DIALECT_QUOTE', '引用符 " が閉じていません。', lineNo, i + 1);
    out.push({ value: text.slice(i + 1, close), column: i + 2 });
    i = close + 1;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i >= text.length || text[i] === '\r') return out;
    if (text[i] !== ',') playErr('E_DIALECT_LINE', 'パートの区切りはカンマ , です。', lineNo, i + 1);
    i++;
  }
}

function parseSongs(text: string): ParsedSong[] {
  const songs: ParsedSong[] = [];
  let current: ParsedSong | null = null;
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    const h = HEADER.exec(line);
    if (h) {
      current = { title: h[2], startLine: lineNo, parts: [] };
      songs.push(current);
      return;
    }
    const d = DATA.exec(line);
    if (!d) playErr('E_DIALECT_LINE', '「行番号 "パート1","パート2",…」の形式ではない行です（BASIC のプログラム文は変換できません）。', lineNo, 1);
    const after = d[0].length;
    if (line[after] !== '"') {
      playErr('E_DIALECT_LINE', '行番号の後には引用符付きの演奏データが必要です（GOTO などの BASIC 文は変換できません）。', lineNo, after + 1);
    }
    const values = quotedList(line, after, lineNo);
    if (values.length > MAX_PARTS) playErr('E_DIALECT_PARTS', `パートは ${MAX_PARTS} 個までです（${values.length} 個あります）。`, lineNo, values[MAX_PARTS].column - 1);
    if (!current) {
      current = { startLine: lineNo, parts: [] };
      songs.push(current);
    }
    const song: ParsedSong = current;
    values.forEach((v, i) => {
      while (song.parts.length <= i) song.parts.push([]);
      song.parts[i].push({ line: lineNo, column: v.column, text: v.value, lineLabel: d[2] });
    });
  });
  return songs;
}

/* ------------------------------------------------------------------ public API */

export function listPc98Songs(text: string): DialectSong[] {
  try {
    return parseSongs(text).map((s, index) => ({ index, title: s.title, startLine: s.startLine, parts: s.parts.length }));
  } catch {
    return [];
  }
}

export function convertPc98Play(text: string, songIndex = 0): DialectConvertResult {
  try {
    const songs = parseSongs(text);
    const song = songs[songIndex];
    if (!song || song.parts.length === 0) {
      playErr('E_DIALECT_NO_DATA', '変換できる演奏データ（「行番号 "…","…"」の行）がありません。', 1, 1);
    }
    const parts = song.parts.map((segments, i) => ({
      kind: i >= 3 ? ('psg' as const) : ('fm' as const),
      name: `パート${i + 1}${i >= 3 ? '（SSG）' : '（FM）'}`,
      segments,
    }));
    return convertPlayParts(parts, PROFILE, song.title, new PlayWarnings());
  } catch (e) {
    if (e instanceof PlayError) return { ok: false, errors: [e.issue] };
    throw e;
  }
}
