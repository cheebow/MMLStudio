// picosakura (Sakura MML, incl. Japanese MML) -> MML Studio MML (SPEC 4.5.7 - 4.5.11).
// Hand-written; the MML Studio language itself is not extended.
import { compileMml } from '../compiler';
import { GM_INSTRUMENTS } from '../gm-instruments';
import { compareMidiEvents } from '../midi-roundtrip';
import { exactTicksTrackLines } from '../midi-to-mml';
import type { CanonChannel, CanonControl, CanonNote, CanonSong } from '../midi-types';
import { PPQ } from '../types';
import { DialectError, fail, gateOf, lengthParts, NOTE_NAMES, singleToken, timeOf, Warnings, WHOLE } from './common';
import { evalExpr, ExprError, truthy, type ExprEnv, type SValue } from './sakura-expr';
import type { DialectConvertResult, DialectSong } from './types';

/* ================================================================== characters */

interface SChar {
  ch: string;
  line: number;
  column: number;
  /** inside a {"..."} string literal: never rewritten */
  str?: boolean;
}

type Pos = { line: number; column: number };

const MIDI_HINT = 'picosakura で MIDI を書き出し、「MIDIを開く」で取り込むと変換できます。';
const MAX_EXPANDED = 4_000_000;
const MAX_MACRO_DEPTH = 16;

function toChars(text: string): SChar[] {
  const out: SChar[] = [];
  let line = 1;
  let column = 1;
  for (const ch of text) {
    if (ch === '\r') continue;
    out.push({ ch, line, column });
    if (ch === '\n') {
      line++;
      column = 1;
    } else column++;
  }
  return out;
}

const charsOf = (s: string, at: Pos): SChar[] => [...s].map((ch) => ({ ch, line: at.line, column: at.column }));

/* ================================================================== 1. comments and strings */

function stripComments(src: SChar[]): SChar[] {
  const out: SChar[] = [];
  let lineStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i].ch;
    const n = src[i + 1]?.ch;
    if (c === '\n') {
      out.push(src[i]);
      lineStart = true;
      continue;
    }
    // {"..."} string literal
    if (c === '"' && lastNonSpace(out)?.ch === '{') {
      const end = src.findIndex((x, k) => k > i && x.ch === '"');
      if (end < 0) fail('E_SAKURA_STRING', '文字列 {"…"} の閉じる " がありません。', src[i]);
      for (let k = i; k <= end; k++) out.push({ ...src[k], str: true });
      i = end;
      lineStart = false;
      continue;
    }
    // TrackName={...} / Copyright={...}: the text inside is a string (may contain any character)
    if (c === '{' && META_BRACE.test(tailText(out))) {
      const close = src.findIndex((x, k) => k > i && x.ch === '}');
      if (close > 0) {
        out.push(src[i]);
        for (let k = i + 1; k < close; k++) out.push({ ...src[k], str: true });
        out.push(src[close]);
        i = close;
        lineStart = false;
        continue;
      }
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i].ch !== '\n') i++;
      i--;
      continue;
    }
    if (c === '/' && n === '*') {
      const start = src[i];
      i += 2;
      while (i < src.length && !(src[i].ch === '*' && src[i + 1]?.ch === '/')) i++;
      if (i >= src.length) fail('E_SAKURA_COMMENT', 'ブロックコメント /* が */ で閉じられていません。', start);
      i++;
      out.push({ ...start, ch: ' ' });
      continue;
    }
    // `##` `#-` `# ` line comments (only at the start of a line)
    if (lineStart && c === '#' && (n === '#' || n === '-' || n === ' ' || n === '\t')) {
      while (i < src.length && src[i].ch !== '\n') i++;
      i--;
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '　') lineStart = false;
    out.push(src[i]);
  }
  return out;
}

const META_BRACE = /(TrackName|TRACK_NAME|Copyright|COPYRIGHT|MetaText|Text|TEXT|Lyric|LYRIC|InstrumentName|CuePoint|Maker|MAKER|曲名|作者|コメント)\s*=?\s*$/;

function tailText(a: SChar[]): string {
  let s = '';
  for (let i = a.length - 1; i >= 0 && s.length < 24; i--) s = a[i].ch + s;
  return s;
}

function lastNonSpace(a: SChar[]): SChar | undefined {
  for (let i = a.length - 1; i >= 0; i--) if (!/\s/.test(a[i].ch)) return a[i];
  return undefined;
}

/* ================================================================== 2. full width */

function normalizeWidth(src: SChar[]): SChar[] {
  return src.map((c) => {
    if (c.str) return c;
    const code = c.ch.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) return { ...c, ch: String.fromCodePoint(code - 0xfee0) };
    if (code === 0x3000) return { ...c, ch: ' ' };
    return c;
  });
}

/* ================================================================== 3. Japanese (SPEC appendix B) */

const JA_WORDS: Array<[string, string]> = [
  ['付点四分音符', 'l4.'],
  ['全音符', 'l1'],
  ['二分音符', 'l2'],
  ['四分音符', 'l4'],
  ['八分音符', 'l8'],
  ['十六音符', 'l16'],
  ['音源初期化', 'System.MeasureShift(1);ResetGM;Time(1:1:0);TrackSync;'],
  ['デクレッシェンド', 'Decresc='],
  ['クレッシェンド', 'Cresc='],
  ['ビブラートオフ', 'M(0)'],
  ['ビブラート', 'M.onNoteWaveEx(0,0,!4,0,96,!8);'],
  ['ここから演奏', 'PlayFrom(Time);'],
  ['方向左前', 'P(32)'],
  ['方向右前', 'P(96)'],
  ['方向回す', 'P.onNoteWaveEx(0,127,!1,127,0,!1);'],
  ['方向左', 'P(0)'],
  ['方向前', 'P(64)'],
  ['方向右', 'P(127)'],
  ['音量予約', 'v.onTime='],
  ['音量戻す', 'EP(127)'],
  ['チャンネル', 'Channel='],
  ['トラック', 'Track='],
  ['テンポ改', 'TempoChange='],
  ['テンポ', 'Tempo='],
  ['演奏位置', 'PlayFrom'],
  ['コメント', 'MetaText='],
  ['ゲート', 'q'],
  ['リズム', 'Rythm'],
  ['ペダル', 'y64,127;'],
  ['大きく', 'Cresc='],
  ['小さく', 'Decresc='],
  ['曖昧さ', '.Random='],
  ['音長', 'l'],
  ['音符', 'l'],
  ['音階', 'o'],
  ['音量', 'v'],
  ['音色', '@'],
  ['時間', 'Time'],
  ['拍子', 'System.TimeSignature='],
  ['連符', 'Div'],
  ['曲名', 'TrackName='],
  ['作者', 'Copyright='],
  ['読む', 'Include'],
  ['予約', '.onNote='],
  ['放す', 'y64,0;'],
  ['調', 'System.KeyFlag'],
  ['ファ', 'f'],
  ['ふぁ', 'f'],
  ['「', "'"],
  ['」', "'"],
  ['【', '['],
  ['】', ']'],
  ['↑', '>'],
  ['↓', '<'],
  ['上', '>'],
  ['下', '<'],
  ['♭', '-'],
  ['♯', '#'],
  ['−', '-'],
  ['‘', '`'],
  ['ー', '^'],
  ['変', '-'],
  ['嬰', '+'],
  ['ド', 'c'],
  ['レ', 'd'],
  ['ミ', 'e'],
  ['フ', 'f'],
  ['ァ', ''],
  ['ソ', 'g'],
  ['ラ', 'a'],
  ['シ', 'b'],
  ['ン', 'r'],
  ['ッ', 'r'],
  ['ど', 'c'],
  ['れ', 'd'],
  ['み', 'e'],
  ['ふ', 'f'],
  ['ぁ', ''],
  ['そ', 'g'],
  ['ら', 'a'],
  ['し', 'b'],
  ['ん', 'r'],
  ['っ', 'r'],
  ['イ', 'a'],
  ['ロ', 'b'],
  ['ハ', 'c'],
  ['ニ', 'd'],
  ['ホ', 'e'],
  ['ヘ', 'f'],
  ['ト', 'g'],
];
/** Only inside rhythm blocks (SPEC 4.5.8-3). */
const JA_DRUMS: Array<[string, string]> = [
  ['ず', 'n36,'],
  ['た', 'n38,'],
  ['つ', 'n42,'],
  ['ち', 'n46,'],
  ['ぱ', 'n49,'],
  ['と', 'n50,'],
  ['む', 'n47,'],
  ['ろ', 'n43,'],
  ['く', 'n44,'],
];
const JA_SORTED = [...JA_WORDS].sort((a, b) => b[0].length - a[0].length);
const RHYTHM_WORDS = ['Rhythm', 'RHYTHM', 'Rythm', 'RYTHM'];

function replaceJapanese(src: SChar[], warn: Warnings): SChar[] {
  const out: SChar[] = [];
  let rhythmPending = false;
  let rhythmDepth = 0;
  let japanese = false;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c.str) {
      out.push(c);
      i++;
      continue;
    }
    if (c.ch === '{') {
      if (rhythmPending) {
        rhythmDepth = 1;
        rhythmPending = false;
      } else if (rhythmDepth > 0) rhythmDepth++;
    } else if (c.ch === '}' && rhythmDepth > 0) rhythmDepth--;
    if (c.ch.charCodeAt(0) < 0x80) {
      out.push(c);
      i++;
      if (/[A-Za-z]/.test(c.ch)) {
        const tail = out.slice(-6).map((x) => x.ch).join('');
        if (RHYTHM_WORDS.some((w) => tail.endsWith(w)) || (c.ch === 'R' && !/[A-Za-z]/.test(out[out.length - 2]?.ch ?? ''))) rhythmPending = true;
      } else if (!/\s/.test(c.ch)) rhythmPending = false;
      continue;
    }
    const table = rhythmDepth > 0 ? [...JA_DRUMS, ...JA_SORTED] : JA_SORTED;
    let hit: [string, string] | undefined;
    for (const entry of table) {
      const w = entry[0];
      let ok = true;
      for (let k = 0; k < w.length; k++) {
        if (src[i + k]?.ch !== w[k] || src[i + k]?.str) {
          ok = false;
          break;
        }
      }
      if (ok && (!hit || w.length > hit[0].length)) hit = entry;
    }
    if (!hit) fail('E_SAKURA_CHAR', `変換できない文字です: ${c.ch}`, c);
    japanese = true;
    out.push(...charsOf(hit[1], c));
    if (hit[1] === 'Rythm') rhythmPending = true;
    i += hit[0].length;
  }
  if (japanese) warn.add('I_SAKURA_JAPANESE', '日本語 MML を英字の MML に置き換えて変換しました。', src.find((c) => c.ch.charCodeAt(0) >= 0x80 && !c.str) ?? { line: 1, column: 1 });
  return out;
}

/* ================================================================== 4. macros and constants */

const UNSUPPORTED = new Set(
  [
    'Result', 'Play', 'PLAY', 'Print', 'PRINT', 'Replace', 'REPLACE',
    'Mid', 'MID', 'Random', 'RANDOM', 'RandomInt', 'RND', 'Rnd', 'RandomSelect', 'RandomSeed', 'RANDOM_SEED', 'System.RandomSeed',
    'Include', 'INCLUDE', 'System.Include', 'DirectSMF', 'NoteOn', 'NoteOff', 'RPN', 'NRPN', 'ArrayFlatten', 'SizeOf',
    'StrLen', 'Chr', 'Asc', 'Hex', 'Pos', 'NoteNo', 'OctaveUnison', 'Unison', 'Unison5th', 'Unison3th', 'RndTiming',
  ],
);

const isUpperStart = (c: string | undefined) => !!c && /[A-Z_]/.test(c);
const isIdent = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

interface Defs {
  macros: Map<string, SChar[]>;
  strs: Map<string, SChar[]>;
  ints: Map<string, number>;
  /** rhythm macros ($x{...}) */
  rhythm: Map<string, string>;
  meta: Array<{ kind: string; text: string }>;
}

function readBraces(src: SChar[], open: number): { body: SChar[]; end: number } {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k].str) continue;
    if (src[k].ch === '{') depth++;
    else if (src[k].ch === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, k), end: k };
    }
  }
  fail('E_SAKURA_SYNTAX', '{ が } で閉じられていません。', src[open]);
}

const skipSpace = (src: SChar[], i: number) => {
  while (i < src.length && /[ \t]/.test(src[i].ch) && !src[i].str) i++;
  return i;
};

function expand(src: SChar[], defs: Defs, depth: number, warn: Warnings): SChar[] {
  if (depth > MAX_MACRO_DEPTH) fail('E_SAKURA_MACRO', `マクロの展開が ${MAX_MACRO_DEPTH} 段を超えました（再帰している可能性があります）。`, src[0] ?? { line: 1, column: 1 });
  const out: SChar[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c.str) {
      out.push(c);
      continue;
    }
    // $x{...} rhythm macro definition
    if (c.ch === '$' && src[i + 2]?.ch === '{') {
      const { body, end } = readBraces(src, i + 2);
      defs.rhythm.set(src[i + 1].ch, body.map((x) => x.ch).join(''));
      i = end;
      continue;
    }
    if (c.ch === '#' && isIdent(src[i + 1]?.ch)) {
      const prev = out[out.length - 1];
      // `c#` (directly after a note name) is a sharp, not a macro
      if (prev && /[a-g]/.test(prev.ch)) {
        out.push(c);
        continue;
      }
      let k = i + 1;
      let name = '';
      while (isIdent(src[k]?.ch)) name += src[k++].ch;
      const eq = skipSpace(src, k);
      if (src[eq]?.ch === '=') {
        const open = skipSpace(src, eq + 1);
        if (src[open]?.ch !== '{') fail('E_SAKURA_MACRO', `マクロ #${name} の定義は #${name}={…} の形で書いてください。`, c);
        const { body, end } = readBraces(src, open);
        defs.macros.set(name, body);
        i = end;
        continue;
      }
      const body = defs.macros.get(name);
      if (!body) fail('E_SAKURA_MACRO', `未定義のマクロ #${name} です。`, c);
      const args: SChar[][] = [];
      let next = k;
      if (body.some((x) => x.ch === '?') && src[skipSpace(src, k)]?.ch === '{') {
        // #NAME{arg1},{arg2}
        next = skipSpace(src, k);
        for (;;) {
          const { body: arg, end } = readBraces(src, next);
          args.push(arg);
          next = end + 1;
          if (src[next]?.ch === ',' && src[next + 1]?.ch === '{') next++;
          else break;
        }
      }
      let inst = body;
      if (args.length > 0) {
        inst = [];
        for (let b = 0; b < body.length; b++) {
          if (body[b].ch === '#' && body[b + 1]?.ch === '?' && /[0-9]/.test(body[b + 2]?.ch ?? '')) {
            inst.push(...(args[Number(body[b + 2].ch) - 1] ?? []));
            b += 2;
          } else inst.push(body[b]);
        }
      }
      out.push(...expand(inst, defs, depth + 1, warn));
      i = next - 1;
      continue;
    }
    // Str / Int / Function and the other program statements are evaluated by the interpreter (runtime).
    // Skip over words so that `#` inside them is not taken as a macro.
    if (isUpperStart(c.ch)) {
      let k = i;
      while (isIdent(src[k]?.ch)) out.push(src[k++]);
      i = k - 1;
      continue;
    }
    out.push(c);
  }
  if (out.length > MAX_EXPANDED) fail('E_SAKURA_LIMIT', '展開後の MML が大きすぎます。', src[0]);
  return out;
}

/* ================================================================== 5. rhythm blocks */

const RHYTHM_DEFAULT: Record<string, string> = { b: 'n36,', s: 'n38,', h: 'n42,', m: 'n46,', c: 'n49,', H: 'n50,', M: 'n47,', L: 'n43,', o: 'n46,', _: 'r' };

function expandRhythm(src: SChar[], defs: Defs): SChar[] {
  const out: SChar[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!c.str && /[A-Z]/.test(c.ch) && !isIdent(src[i - 1]?.ch)) {
      let k = i;
      let word = '';
      while (isIdent(src[k]?.ch)) word += src[k++].ch;
      const open = skipSpace(src, k);
      if ((RHYTHM_WORDS.includes(word) || word === 'R') && src[open]?.ch === '{') {
        const { body, end } = readBraces(src, open);
        for (const b of body) {
          const m = !b.str && (defs.rhythm.get(b.ch) ?? RHYTHM_DEFAULT[b.ch]);
          if (m) out.push(...charsOf(m, b));
          else out.push(b);
        }
        i = end;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/* ================================================================== 6. loops */

/** `Int NAME=<integer literal>` constants, usable as loop counts (`[N c]`). */
function literalInts(src: SChar[]): Map<string, number> {
  const text = src.map((c) => (c.str ? ' ' : c.ch)).join('');
  const found = new Map<string, number | null>();
  for (const m of text.matchAll(/\b(?:Int|INT)\s+([A-Za-z_]\w*)\s*=\s*([+-]?\d+)(?![\d*/+\-(])/g)) {
    found.set(m[1], found.has(m[1]) && found.get(m[1]) !== Number(m[2]) ? null : Number(m[2]));
  }
  const out = new Map<string, number>();
  for (const [k, v] of found) if (v !== null) out.set(k, v);
  return out;
}

function expandLoops(src: SChar[], ints: Map<string, number> = new Map()): SChar[] {
  const out: SChar[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c.str || c.ch !== '[') {
      if (!c.str && c.ch === ']') fail('E_SAKURA_SYNTAX', '対応する [ のない ] です。', c);
      out.push(c);
      continue;
    }
    // [n body : tail ]
    let k = skipSpace(src, i + 1);
    let count = '';
    while (/[0-9]/.test(src[k]?.ch ?? '')) count += src[k++].ch;
    if (count === '' && isUpperStart(src[k]?.ch)) {
      let e = k;
      let name = '';
      while (isIdent(src[e]?.ch)) name += src[e++].ch;
      if (ints.has(name)) {
        count = String(ints.get(name));
        k = e;
      }
    }
    const times = count === '' ? 2 : Number(count);
    let depth = 1;
    let paren = 0;
    let colon = -1;
    let end = -1;
    for (let j = k; j < src.length; j++) {
      const x = src[j];
      if (x.str) continue;
      if (x.ch === '(') paren++;
      else if (x.ch === ')') paren--;
      else if (x.ch === '[') depth++;
      else if (x.ch === ']') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (x.ch === ':' && depth === 1 && paren === 0 && colon < 0) colon = j;
    }
    if (end < 0) fail('E_SAKURA_SYNTAX', '繰り返し [ が ] で閉じられていません。', c);
    const body = expandLoops(src.slice(k, colon >= 0 ? colon : end), ints);
    const tail = colon >= 0 ? expandLoops(src.slice(colon + 1, end), ints) : [];
    // a blank between the repetitions keeps words apart (`[2 O1]` -> `O1 O1`, not `O1O1`)
    const sep = { ...c, ch: ' ' };
    out.push(sep);
    for (let t = 0; t < times; t++) {
      out.push(...body, sep);
      if (t < times - 1 && tail.length) out.push(...tail, sep);
      if (out.length > MAX_EXPANDED) fail('E_SAKURA_LIMIT', '繰り返しを展開した MML が大きすぎます。', c);
    }
    out.push({ ...c, ch: ' ' });
    i = end;
  }
  return out;
}

/* ================================================================== 7. interpretation */

type GateSpec = { mode: 'percent'; value: number } | { mode: 'ticks'; value: number };

type Item =
  | { kind: 'note'; pitches: number[]; start: number; duration: number; gate: GateSpec; velocity: number; line: number }
  | { kind: 'rest'; start: number; duration: number; line: number }
  | { kind: 'control'; tick: number; control: CanonControl; text: string; line: number }
  | { kind: 'length'; ticks: number; line: number };

interface VTrack {
  /** Sakura track number */
  id: number;
  channel: number;
  items: Item[];
  hasEvents: boolean;
}

interface TrackState {
  id: number;
  vtrack: VTrack;
  octave: number;
  length: number;
  velocity: number;
  gate: GateSpec;
  cursor: number;
  trackKey: number;
}

interface Song {
  vtracks: VTrack[];
  tempos: Array<{ tick: number; us: number; bpm: number | null; at: Pos }>;
  meta: Array<{ kind: string; text: string }>;
  /** channels switched to rhythm parts by a GS "Use for Rhythm Part" SysEx */
  drumChannels: Map<number, Pos>;
}

type Var = { t: 'int'; v: number } | { t: 'str'; chars: SChar[] };
type Param = { name: string; type: 'int' | 'str' | 'any'; def?: string };
interface FuncDef {
  name: string;
  params: Param[];
  body: SChar[];
}

/** control flow of Sakura programs (not errors) */
class ReturnSignal {}
class BreakSignal {}
class ContinueSignal {}

const MAX_LOOP = 100_000;
const MAX_STEPS = 20_000_000;
const MAX_CALL_DEPTH = 64;
/** codes that stop a strict conversion but are skipped (with a warning) in best-effort mode */
const NOT_SKIPPABLE = new Set(['E_SAKURA_LIMIT', 'E_SAKURA_MACRO', 'E_SAKURA_COMMENT', 'E_SAKURA_STRING']);
const KEYWORDS_INT = new Set(['Int', 'INT']);
const KEYWORDS_STR = new Set(['Str', 'STR']);

const textOf = (chars: SChar[]) => chars.map((c) => c.ch).join('');
function trimChars(chars: SChar[]): SChar[] {
  let a = 0;
  let b = chars.length;
  while (a < b && /\s/.test(chars[a].ch) && !chars[a].str) a++;
  while (b > a && /\s/.test(chars[b - 1].ch) && !chars[b - 1].str) b--;
  return chars.slice(a, b);
}
/** split at `sep` outside ( ) and { } */
function splitTop(chars: SChar[], sep: string): SChar[][] {
  const out: SChar[][] = [];
  let depth = 0;
  let cur: SChar[] = [];
  for (const c of chars) {
    if (!c.str) {
      if (c.ch === '(' || c.ch === '{') depth++;
      else if (c.ch === ')' || c.ch === '}') depth--;
      else if (c.ch === sep && depth === 0) {
        out.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(c);
  }
  out.push(cur);
  return out;
}
const isBraced = (chars: SChar[]) => chars.length >= 2 && chars[0].ch === '{' && !chars[0].str && chars[chars.length - 1].ch === '}';

const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const KEYFLAG_ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const CC_COMMANDS: Record<string, number> = {
  M: 1, Modulation: 1, V: 7, MainVolume: 7, P: 10, Panpot: 10, EP: 11, Expression: 11, REV: 91, Reverb: 91,
  CHO: 93, Chorus: 93, VAR: 94, Variation: 94, PT: 5, PortamentoTime: 5, PS: 65, PortamentoSwitch: 65,
};
const WARN_SKIP = new Set([
  'TempoChange', 'TEMPO_CHANGE', 'Cresc', 'CRESC', 'Decresc', 'DECRESC', 'Fadein', 'Fadeout', 'Slur', 'MasterVolume',
  'MasterBalance', 'FineTune', 'CoarseTune', 'VibratoRate', 'VibratoDepth', 'VibratoDelay', 'FilterCutoff', 'FilterResonance',
  'EGAttack', 'EGDecay', 'EGRelease', 'UseKeyShift', 'Port', 'PORT', 'DeviceNumber', 'System.qAdd', 'PlayFrom', 'PLAY_FROM',
  'PlayFromHere', 'GSEffect', 'GSReverbMacro', 'GS_RHYTHM', 'GSScaleTuning',
]);
const IGNORE = new Set(['ResetGM', 'ResetGS', 'ResetXG', 'SoundType', 'MeasureShift_', 'System.Init']);
const META = new Map([
  ['TrackName', '曲名'], ['TRACK_NAME', '曲名'], ['Copyright', '作者'], ['COPYRIGHT', '作者'], ['MetaText', 'コメント'], ['Text', 'コメント'],
  ['TEXT', 'コメント'], ['Lyric', '歌詞'], ['LYRIC', '歌詞'], ['InstrumentName', '楽器名'], ['CuePoint', 'キュー'], ['MAKER', '作成'], ['Maker', '作成'],
]);

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function voiceByName(name: string, at: Pos): number {
  const n = normalizeName(name);
  if (n) {
    const exact = GM_INSTRUMENTS.findIndex((g) => normalizeName(g) === n);
    if (exact >= 0) return exact;
    const partial = GM_INSTRUMENTS.findIndex((g) => normalizeName(g).includes(n));
    if (partial >= 0) return partial;
  }
  fail('E_SAKURA_VOICE', `音色名「${name}」を GM 音色に対応付けられません。番号（@1〜@128）で指定してください。`, at);
}

class Interpreter {
  private p = 0;
  readonly song: Song = { vtracks: [], tempos: [], meta: [], drumChannels: new Map() };
  /** variables: global scope first, one more per function call */
  private readonly scopes: Array<Map<string, Var>> = [new Map()];
  private readonly funcs = new Map<string, FuncDef>();
  private callDepth = 0;
  private steps = 0;
  private includeSeen = false;
  /** a warning or skip changed the result (best-effort mode) */
  approximate = false;
  private readonly tracks = new Map<number, TrackState>();
  private cur: TrackState;
  private timeBase = 96;
  private measureShift = 0;
  private vAdd = 8;
  private key = 0;
  private readonly keyFlag = new Map<string, number>();
  private readonly signatures: Array<{ tick: number; num: number; den: number }> = [];
  private oneShot = 0;
  private ended = false;

  constructor(
    private src: SChar[],
    private readonly warn: Warnings,
    meta: Array<{ kind: string; text: string }>,
    private readonly bestEffort = false,
  ) {
    this.song.meta = meta;
    this.cur = this.track(1);
  }

  /* ---------------------------------------------------------- helpers */
  private peek(o = 0): string {
    return this.src[this.p + o]?.ch ?? '';
  }
  private at(): Pos {
    return this.src[Math.min(this.p, this.src.length - 1)] ?? { line: 1, column: 1 };
  }
  private spaces(): void {
    while (this.p < this.src.length && /[ \t\n;|]/.test(this.peek()) && !this.src[this.p].str) this.p++;
  }
  /** spaces / tabs only (arguments may be separated from their command by spaces) */
  private blanks(): void {
    while (/[ \t]/.test(this.peek())) this.p++;
  }
  private int(signed = false): number | null {
    const save = this.p;
    this.blanks();
    let s = '';
    if (signed && (this.peek() === '-' || this.peek() === '+')) s += this.src[this.p++].ch;
    while (/[0-9]/.test(this.peek())) s += this.src[this.p++].ch;
    if (!/\d/.test(s)) {
      this.p = save;
      return null;
    }
    return Number(s);
  }
  private need(v: number | null, what: string, at: Pos): number {
    if (v === null) fail('E_SAKURA_VALUE', `${what} の後に数値が必要です。`, at);
    return v;
  }
  private stepTicks(steps: number, at: Pos): number {
    const t = (steps * PPQ) / this.timeBase;
    const r = Math.round(t);
    if (r !== t) this.warn.add('W_SAKURA_ROUND', `ステップ数を 480 PPQ の ${r} tick に丸めました。`, at);
    return r;
  }

  private track(id: number): TrackState {
    let t = this.tracks.get(id);
    if (!t) {
      let channel = id;
      if (id < 1 || id > 16) {
        channel = 1;
        this.warn.add('W_SAKURA_CHANNEL', `トラック ${id} のチャンネルを 1 とみなしました（推定）。CH で指定できます。`, this.at());
      }
      const vtrack: VTrack = { id, channel, items: [], hasEvents: false };
      this.song.vtracks.push(vtrack);
      t = { id, vtrack, octave: 5, length: PPQ, velocity: 100, gate: { mode: 'percent', value: 80 }, cursor: 0, trackKey: 0 };
      this.tracks.set(id, t);
    }
    return t;
  }

  private push(item: Item, events = true): void {
    this.cur.vtrack.items.push(item);
    if (events) this.cur.vtrack.hasEvents = true;
  }

  private setChannel(ch: number, at: Pos): void {
    if (ch < 1 || ch > 16) fail('E_SAKURA_RANGE', `チャンネル ${ch} は範囲外です（1〜16）。`, at);
    const t = this.cur;
    if (t.vtrack.channel === ch) return;
    if (t.vtrack.hasEvents) {
      // channel change in the middle of a track: continue in a new virtual track
      this.warn.add('W_SAKURA_CH_CHANGE', 'トラックの途中でチャンネルが変わったため、別のトラックとして出力しました。', at);
      const v: VTrack = { id: t.id, channel: ch, items: [], hasEvents: false };
      this.song.vtracks.push(v);
      t.vtrack = v;
    } else t.vtrack.channel = ch;
  }

  /**
   * n-th note length in ticks (with dots, `%` steps and `+` additions). null when absent.
   * Dots without a number (`c..`) dot the default length `dotBase`.
   */
  private length(at: Pos, dotBase?: number): number | null {
    this.blanks();
    if (this.inTuplet) {
      const save = this.p;
      while (/[0-9.%+]/.test(this.peek())) this.p++;
      if (this.p !== save) this.warn.add('W_SAKURA_TUPLET_LEN', '連符の中の個別の音長は無視しました（{ } の後の音長で等分します）。', at);
      return 1;
    }
    let total: number | null = null;
    for (;;) {
      let ticks: number;
      if (this.peek() === '.' && dotBase !== undefined && total === null) {
        ticks = dotBase;
        let add = ticks / 2;
        let dots = 0;
        while (this.peek() === '.') {
          this.p++;
          dots++;
          ticks += add;
          add /= 2;
        }
        if (dots >= 2) this.warn.add('W_SAKURA_DOTS', '付点 2 個以上は「直前の加算分の半分を足す」として変換しました（推定）。', at);
        ticks = Math.round(ticks);
      } else if (this.peek() === '%') {
        this.p++;
        ticks = this.stepTicks(this.need(this.intArg(), '%', at), at);
      } else if (/[0-9]/.test(this.peek())) {
        const n = this.int() as number;
        if (n < 1) fail('E_SAKURA_RANGE', `音長 ${n} は使えません。`, at);
        const exact = WHOLE / n;
        ticks = Math.round(exact);
        if (ticks !== exact) this.warn.add('W_SAKURA_ROUND', `音長 ${n} を ${ticks} tick に丸めました。`, at);
        let add = ticks / 2;
        let dots = 0;
        while (this.peek() === '.') {
          this.p++;
          dots++;
          ticks += add;
          add /= 2;
        }
        if (dots >= 2) this.warn.add('W_SAKURA_DOTS', '付点 2 個以上は「直前の加算分の半分を足す」として変換しました（推定）。', at);
        ticks = Math.round(ticks);
      } else break;
      total = (total ?? 0) + ticks;
      // `8+2`: length addition (only when a digit follows)
      if (this.peek() === '+' && /[0-9%]/.test(this.peek(1))) {
        this.p++;
        this.warn.add('W_SAKURA_PLUS', '音長の + は足し算として変換しました（推定）。', at);
        continue;
      }
      break;
    }
    return total;
  }

  private pitchOf(letter: string, octave: number, at: Pos): number {
    let acc = 0;
    let explicit = false;
    while (this.peek() === '+' || this.peek() === '#' || this.peek() === '-') {
      // `+` followed by a digit is a length addition, not a sharp
      if (this.peek() === '+' && /[0-9]/.test(this.peek(1))) break;
      acc += this.src[this.p++].ch === '-' ? -1 : 1;
      explicit = true;
    }
    if (!explicit) acc += this.keyFlag.get(letter) ?? 0;
    const pitch = 12 * (octave + this.oneShot) + SEMI[letter] + acc + this.key + this.cur.trackKey;
    this.oneShot = 0;
    if (pitch < 0 || pitch > 127) fail('E_SAKURA_RANGE', `音高が MIDI の範囲を超えています（${pitch}）。`, at);
    return pitch;
  }

  /** `,q,v,t,o` parameters after a note / chord. */
  private params(first: 'q' | 'l', at: Pos): { length?: number | null; gate?: GateSpec; velocity?: number } {
    const res: { length?: number | null; gate?: GateSpec; velocity?: number } = {};
    const order = first === 'l' ? ['l', 'q', 'v', 't', 'o'] : ['q', 'v', 't', 'o'];
    let idx = 0;
    while (this.peek() === ',' && idx < order.length) {
      this.p++;
      const what = order[idx++];
      this.blanks();
      if (what === 'l') {
        res.length = this.length(at);
      } else if (what === 'q') {
        if (this.peek() === '%') {
          this.p++;
          res.gate = { mode: 'ticks', value: this.stepTicks(this.need(this.int(), 'q%', at), at) };
        } else {
          const q = this.int();
          if (q !== null) res.gate = { mode: 'percent', value: Math.min(100, q) };
        }
      } else if (what === 'v') {
        const v = this.int();
        if (v !== null) res.velocity = Math.max(0, Math.min(127, v));
      } else if (what === 't') {
        if (this.int(true) !== null) this.warn.add('W_SAKURA_TIMING', 't（発音タイミングのずらし）は変換しません。', at);
      } else if (what === 'o') {
        const o = this.int();
        if (o !== null) this.warn.add('W_SAKURA_PARAM_O', '音符の後のオクターブ指定は無視しました。', at);
      }
    }
    return res;
  }

  private ties(duration: number, at: Pos): number {
    let d = duration;
    for (;;) {
      this.blanks();
      if (this.peek() !== '^') return d;
      this.p++;
      d += this.length(at) ?? this.cur.length;
    }
  }

  private lastNote(): Extract<Item, { kind: 'note' }> | null {
    const items = this.cur.vtrack.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'note') return it;
      if (it.kind === 'rest') return null;
    }
    return null;
  }

  private emitNote(pitches: number[], duration: number, at: Pos, extra: { gate?: GateSpec; velocity?: number }, tie: boolean): void {
    const t = this.cur;
    if (tie) {
      // `&`: same pitch(es) extend the previous note; otherwise legato
      const prev = this.lastNote();
      const sameScale = !this.inTuplet || (prev !== null && prev.start >= this.tupletOrigin);
      if (prev && sameScale && prev.start + prev.duration === t.cursor && prev.pitches.length === pitches.length && prev.pitches.every((x, i) => x === pitches[i])) {
        prev.duration += duration;
        t.cursor += duration;
        return;
      }
      if (prev) {
        prev.gate = { mode: 'percent', value: 100 };
        this.warn.add('W_SAKURA_SLUR', '異なる音高の & は、前の音を次の音まで隙間なく鳴らす形で変換しました。', at);
      }
    }
    this.push({ kind: 'note', pitches, start: t.cursor, duration, gate: extra.gate ?? t.gate, velocity: extra.velocity ?? t.velocity, line: at.line });
    t.cursor += duration;
  }

  private control(control: CanonControl, text: string, at: Pos): void {
    this.push({ kind: 'control', tick: this.cur.cursor, control: { ...control, tick: this.cur.cursor }, text, line: at.line });
  }

  /** `(...)`, `=...` or space-separated arguments. Returns raw argument strings. */
  private args(): string[] | null {
    this.blanks();
    const readUntil = (close: string | null) => {
      const parts: string[] = [];
      let cur = '';
      let depth = 0;
      while (this.p < this.src.length) {
        const c = this.src[this.p];
        if (close && !c.str && c.ch === close && depth === 0) {
          this.p++;
          break;
        }
        if (!close && !c.str && (/[\s;|]/.test(c.ch) || (/[A-Za-z@'`"[\]>]/.test(c.ch) && depth === 0))) break;
        if (!c.str && (c.ch === '(' || c.ch === '{')) depth++;
        if (!c.str && (c.ch === ')' || c.ch === '}')) depth--;
        if (!c.str && (c.ch === ',' || c.ch === ':') && depth === 0) {
          parts.push(cur.trim());
          cur = '';
        } else cur += c.ch;
        this.p++;
      }
      parts.push(cur.trim());
      return parts;
    };
    if (this.peek() === '(') {
      this.p++;
      return readUntil(')');
    }
    if (this.peek() === '=') {
      this.p++;
      this.blanks();
      if (this.peek() === '(') {
        this.p++;
        return readUntil(')');
      }
      if (this.peek() === '{') {
        const start = this.p;
        let depth = 0;
        let s = '';
        while (this.p < this.src.length) {
          const c = this.src[this.p++];
          if (!c.str && c.ch === '{') depth++;
          if (!c.str && c.ch === '}') {
            depth--;
            if (depth === 0) break;
          }
          s += c.ch;
        }
        if (depth !== 0) fail('E_SAKURA_SYNTAX', '{ が } で閉じられていません。', this.src[start]);
        return [s.slice(1)];
      }
      return this.exprList();
    }
    if (this.peek() === '{') {
      const v = this.args2braces();
      return [v];
    }
    if (/[0-9+-]/.test(this.peek())) return this.exprList();
    return null;
  }
  /** `=1,2` / ` 1`: comma-separated expressions */
  private exprList(): string[] {
    const out = [textOf(this.readExprChars()).trim()];
    while (this.peek() === ',' && /[0-9A-Za-z_($+-]/.test(this.peek(1))) {
      this.p++;
      out.push(textOf(this.readExprChars()).trim());
    }
    return out;
  }
  private args2braces(): string {
    let depth = 0;
    let s = '';
    while (this.p < this.src.length) {
      const c = this.src[this.p++];
      if (!c.str && c.ch === '{') depth++;
      if (!c.str && c.ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      s += c.ch;
    }
    return s.slice(1);
  }
  private num(s: string | undefined, what: string, at: Pos): number {
    if (s === undefined || s.trim() === '') fail('E_SAKURA_VALUE', `${what} の後に数値が必要です。`, at);
    if (/^[+-]?\d+$/.test(s.trim())) return Number(s.trim());
    return Math.trunc(this.evalNum(s, what, at));
  }
  /** skip `(...)` / `=...` arguments of a command that is not converted */
  private skipArgs(): void {
    this.args();
  }

  /* ---------------------------------------------------------- main loop */
  run(): void {
    try {
      this.loop();
    } catch (e) {
      if (e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) return;
      throw e;
    }
  }

  private loop(): void {
    while (this.p < this.src.length && !this.ended) {
      this.spaces();
      if (this.p >= this.src.length) break;
      this.step();
    }
  }

  /** Interprets `chars` (a Str value, function body, If / For body) and returns to the current position. */
  private execDepth = 0;
  private exec(chars: SChar[]): void {
    if (this.execDepth >= 256) fail('E_SAKURA_MACRO', 'Str・関数の展開が深すぎます（再帰している可能性があります）。', this.at());
    this.execDepth++;
    const save = { src: this.src, p: this.p };
    this.src = chars;
    this.p = 0;
    try {
      this.loop();
    } finally {
      this.src = save.src;
      this.p = save.p;
      this.execDepth--;
    }
  }

  /** One command. In best-effort mode, errors become warnings and the command is skipped. */
  private step(): void {
    if (++this.steps > MAX_STEPS) fail('E_SAKURA_LIMIT', '処理が多すぎるため変換を中止しました（無限ループの可能性があります）。', this.at());
    const before = this.p;
    try {
      this.command();
    } catch (e) {
      if (!(e instanceof DialectError) || !this.bestEffort || NOT_SKIPPABLE.has(e.issue.code)) throw e;
      this.skipped(e.issue.message.replace(MIDI_HINT, '').trim(), e.issue);
    }
    if (this.p === before) this.p++;
  }

  /** best-effort: record something that was not converted */
  private skipped(message: string, at: Pos, suffix = '（近似変換: スキップしました）'): void {
    this.approximate = true;
    this.warn.add('W_SAKURA_APPROX', `${message}${suffix}`, at);
  }

  /** strict: error / best-effort: warning */
  private unsupported(message: string, at: Pos): void {
    if (!this.bestEffort) fail('E_SAKURA_UNSUPPORTED', `${message}${MIDI_HINT}`, at);
    this.skipped(message, at);
  }

  /* ---------------------------------------------------------- variables and expressions */
  private lookupVar(name: string): Var | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) return v;
    }
    return undefined;
  }
  private setVar(name: string, v: Var, declare: boolean): void {
    if (!declare) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        if (this.scopes[i].has(name)) {
          this.scopes[i].set(name, v);
          return;
        }
      }
    }
    this.scopes[this.scopes.length - 1].set(name, v);
  }

  private readonly env: ExprEnv = {
    lookup: (name) => {
      const v = this.lookupVar(name);
      if (v) return v.t === 'int' ? v.v : textOf(v.chars);
      switch (name) {
        case 'CH':
        case 'Channel':
        case 'CHANNEL':
          return this.cur.vtrack.channel;
        case 'TR':
        case 'Track':
        case 'TRACK':
          return this.cur.id;
        case 'DeviceNumber':
          return 0x10;
        case 'TRUE':
        case 'True':
        case 'true':
          return 1;
        case 'FALSE':
        case 'False':
        case 'false':
          return 0;
      }
      return undefined;
    },
    call: (name, args) => {
      if (name === 'MML' && args.length === 1) {
        const a = args[0].trim();
        if (a === 'v') return this.cur.velocity;
        if (a === 'o') return this.cur.octave;
        if (a === 'q' && this.cur.gate.mode === 'percent') return this.cur.gate.value;
        if (a === 'l') return Math.round((this.cur.length * this.timeBase) / PPQ);
        if (a === 'TrackKey') return this.cur.trackKey;
      }
      return undefined;
    },
  };

  private evalValue(text: string, what: string, at: Pos): SValue {
    try {
      return evalExpr(text, this.env);
    } catch (e) {
      if (e instanceof ExprError) fail('E_SAKURA_EXPR', `${what} の値「${text.trim()}」を変換時に求められません（${e.message}）。${MIDI_HINT}`, at);
      throw e;
    }
  }
  private evalNum(text: string, what: string, at: Pos): number {
    const v = this.evalValue(text, what, at);
    if (typeof v === 'number') return v;
    if (/^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    fail('E_SAKURA_EXPR', `${what} の値「${text.trim()}」は数値ではありません（「${v}」）。${MIDI_HINT}`, at);
  }

  /** at `(`: the chars inside the balanced parentheses; moves past `)` */
  private parenChars(): SChar[] {
    const open = this.p;
    let depth = 0;
    for (let k = open; k < this.src.length; k++) {
      const c = this.src[k];
      if (c.str) continue;
      if (c.ch === '(' || c.ch === '{') depth++;
      else if (c.ch === ')' || c.ch === '}') {
        depth--;
        if (depth === 0) {
          this.p = k + 1;
          return this.src.slice(open + 1, k);
        }
      }
    }
    fail('E_SAKURA_SYNTAX', '( が ) で閉じられていません。', this.src[open]);
  }
  /** at `{`: the chars inside the braces; moves past `}` */
  private braceChars(): SChar[] {
    const { body, end } = readBraces(this.src, this.p);
    this.p = end + 1;
    return body;
  }

  /**
   * One expression written after `=` without parentheses (`DL=BGN-1MNH` reads `BGN-1`).
   * Only + - * / join operands, so the MML that follows is not taken in.
   */
  private readExprChars(): SChar[] {
    const start = this.p;
    let expectOperand = true;
    for (;;) {
      if (expectOperand) {
        this.blanks();
        const c = this.peek();
        if (c === '-' || c === '+' || c === '!') {
          this.p++;
          continue;
        }
        if (c === '(') this.parenChars();
        else if (c === '{') this.braceChars();
        else if (/[0-9]/.test(c)) {
          while (/[0-9]/.test(this.peek()) || (this.peek() === '.' && /[0-9]/.test(this.peek(1)))) this.p++;
        } else if (c === '$' && /[0-9A-Fa-f]/.test(this.peek(1))) {
          this.p++;
          while (/[0-9A-Fa-f]/.test(this.peek())) this.p++;
        } else if (/[A-Za-z_]/.test(c)) {
          while (/[A-Za-z0-9_]/.test(this.peek())) this.p++;
          if (this.peek() === '(') this.parenChars();
        } else break;
        expectOperand = false;
      } else {
        const c = this.peek();
        if ('+-*/'.includes(c) && c !== '' && /[0-9A-Za-z_($]/.test(this.peek(1))) {
          this.p++;
          expectOperand = true;
          continue;
        }
        break;
      }
    }
    return this.src.slice(start, this.p);
  }

  /** `v=(X8)`, `v(J)`, `@N`, `p%=-100`: a numeric command argument. null when absent. */
  private intArg(signed = false): number | null {
    const save = this.p;
    const at = this.at();
    this.blanks();
    if (this.peek() === '=' && this.peek(1) !== '=') {
      this.p++;
      this.blanks();
    }
    if (this.peek() === '(') {
      const inner = this.parenChars();
      return Math.trunc(this.evalNum(textOf(inner), '引数', at));
    }
    const n = this.int(signed);
    if (n !== null) return n;
    if (isUpperStart(this.peek())) {
      let k = this.p;
      let name = '';
      while (isIdent(this.src[k]?.ch)) name += this.src[k++].ch;
      const v = this.lookupVar(name);
      if (v?.t === 'int') {
        this.p = k;
        return v.v;
      }
    }
    this.p = save;
    return null;
  }

  private command(): void {
    const at = this.at();
    const sc = this.src[this.p];
    if (sc.str) fail('E_SAKURA_SYNTAX', '予期しない文字列です。', at);
    const c = sc.ch;
    if (c in SEMI) {
      this.p++;
      this.note(c, at);
      return;
    }
    switch (c) {
      case 'r': {
        this.p++;
        let d = this.length(at, this.cur.length) ?? this.cur.length;
        d = this.ties(d, at);
        this.push({ kind: 'rest', start: this.cur.cursor, duration: d, line: at.line }, false);
        this.cur.cursor += d;
        return;
      }
      case 'n': {
        this.p++;
        const no = this.need(this.int(), 'n', at);
        if (no > 127) fail('E_SAKURA_RANGE', `n${no} は範囲外です（0〜127）。`, at);
        const prm = this.params('l', at);
        let d = prm.length ?? this.cur.length;
        d = this.ties(d, at);
        const pitch = no + this.key + this.cur.trackKey;
        this.emitNote([pitch], d, at, prm, this.consumeTie());
        return;
      }
      case 'o': {
        this.p++;
        this.blanks();
        const o = this.need(this.intArg(), 'o', at);
        if (o < 0 || o > 10) fail('E_SAKURA_RANGE', `o${o} は範囲外です（0〜10）。`, at);
        this.cur.octave = o;
        return;
      }
      case '>':
        this.p++;
        this.cur.octave++;
        return;
      case '<':
        this.p++;
        this.cur.octave--;
        return;
      case '`':
        this.p++;
        this.oneShot++;
        return;
      case '"':
        this.p++;
        this.oneShot--;
        return;
      case 'l': {
        this.p++;
        if (this.method()) return;
        const len = this.length(at);
        if (len === null) fail('E_SAKURA_VALUE', 'l の後に音長が必要です。', at);
        this.cur.length = len;
        this.push({ kind: 'length', ticks: len, line: at.line }, false);
        return;
      }
      case 'v': {
        this.p++;
        if (this.method()) return;
        this.blanks();
        if (this.peek() === '+' && this.peek(1) === '+') {
          this.p += 2;
          this.cur.velocity = Math.min(127, this.cur.velocity + this.vAdd);
          return;
        }
        if (this.peek() === '-' && this.peek(1) === '-') {
          this.p += 2;
          this.cur.velocity = Math.max(0, this.cur.velocity - this.vAdd);
          return;
        }
        const v = this.need(this.intArg(), 'v', at);
        if (v > 127 || v < 0) fail('E_SAKURA_RANGE', `v${v} は範囲外です（0〜127）。`, at);
        this.cur.velocity = v;
        return;
      }
      case ')':
        this.p++;
        this.cur.velocity = Math.min(127, this.cur.velocity + this.vAdd);
        return;
      case '(':
        this.p++;
        this.cur.velocity = Math.max(0, this.cur.velocity - this.vAdd);
        return;
      case 'q': {
        this.p++;
        if (this.method()) return;
        this.blanks();
        if (this.peek() === '%') {
          this.p++;
          this.cur.gate = { mode: 'ticks', value: this.stepTicks(this.need(this.intArg(), 'q%', at), at) };
          return;
        }
        const q = this.need(this.intArg(), 'q', at);
        if (q > 100) this.warn.add('W_SAKURA_GATE', `q${q} は 100 として変換しました。`, at);
        this.cur.gate = { mode: 'percent', value: Math.min(100, q) };
        return;
      }
      case 't': {
        this.p++;
        if (this.method()) return;
        this.int(true);
        this.warn.add('W_SAKURA_TIMING', 't（発音タイミングのずらし）は変換しません。', at);
        return;
      }
      case 'p': {
        this.p++;
        if (this.method()) return;
        this.blanks();
        if (this.peek() === '%') {
          this.p++;
          const v = this.need(this.intArg(true), 'p%', at);
          this.bend(v, at);
          return;
        }
        const v = this.need(this.intArg(), 'p', at);
        this.bend(Math.max(-8192, Math.min(8191, (v - 64) * 128)), at);
        return;
      }
      case 'y': {
        this.p++;
        const n = this.need(this.int(), 'y', at);
        if (this.peek() === '.') {
          this.method();
          return;
        }
        this.blanks();
        if (this.peek() !== ',') fail('E_SAKURA_VALUE', 'y は y番号,値 の形で書いてください（例: y64,127）。', at);
        this.p++;
        const v = this.need(this.int(), 'y', at);
        this.cc(n, v, at);
        return;
      }
      case '@': {
        this.p++;
        this.blanks();
        if (this.peek() === '(') {
          const inner = this.parenChars();
          // @(n,msb,lsb) with expressions, or @(voice name)
          const parts = splitTop(inner, ',').map((x) => textOf(x));
          let nums: number[] | null = null;
          try {
            nums = parts.map((x) => Math.trunc(this.evalNum(x, '@', at)));
          } catch (e) {
            if (!(e instanceof DialectError)) throw e;
          }
          if (nums) {
            this.program(nums[0], nums[1] ?? null, nums[2] ?? null, at);
            return;
          }
          const name = textOf(inner);
          this.program(voiceByName(name, at) + 1, null, null, at);
          this.warn.add('W_SAKURA_VOICE_NAME', `音色名「${name.trim()}」を GM 音色名と照合しました（推定）。`, at);
          return;
        }
        const n = this.need(this.intArg(), '@', at);
        let msb: number | null = null;
        let lsb: number | null = null;
        if (this.peek() === ',') {
          this.p++;
          msb = this.int();
          if (this.peek() === ',') {
            this.p++;
            lsb = this.int();
          }
        }
        this.program(n, msb, lsb, at);
        return;
      }
      case "'":
        this.p++;
        this.chord(at);
        return;
      case '{':
        this.tuplet(at);
        return;
      case '&':
        this.p++;
        if (this.peek() === '&') {
          this.p++;
          this.warn.add('W_SAKURA_DOUBLE_AMP', '&& は & と同じく、前の音を次の音まで隙間なく鳴らす形で変換しました（音高の滑らかな変化は再現しません・推定）。', at);
        }
        this.pendingTie = true;
        return;
      case '^': {
        // `c&&^` / `c ^`: lengthen the previous note when it ends here
        const prev = this.lastNote();
        if (!prev || prev.start + prev.duration !== this.cur.cursor) fail('E_SAKURA_SYNTAX', '^ の前に音符か休符が必要です。', at);
        this.p++;
        const add = this.length(at) ?? this.cur.length;
        prev.duration += add;
        this.cur.cursor += add;
        return;
      }
      case '}':
        fail('E_SAKURA_SYNTAX', '対応する { のない } です。', at);
        break;
      default:
        if (/[A-Z_]/.test(c)) {
          this.word(at);
          return;
        }
        fail('E_SAKURA_CHAR', `変換できない文字です: ${c}`, at);
    }
  }

  private pendingTie = false;
  private consumeTie(): boolean {
    const t = this.pendingTie;
    this.pendingTie = false;
    return t;
  }

  /** `v.onTime(...)` / `t.Random=n` style method calls: skipped with a warning. */
  private method(): boolean {
    if (this.peek() !== '.') return false;
    const at = this.at();
    this.p++;
    let name = '';
    while (/[A-Za-z]/.test(this.peek())) name += this.src[this.p++].ch;
    this.skipArgs();
    this.warn.add('W_SAKURA_TIMED', `.${name} などの時間変化・ランダム指定は変換しません。`, at);
    return true;
  }

  private note(letter: string, at: Pos): void {
    const pitch = this.pitchOf(letter, this.cur.octave, at);
    let d = this.length(at, this.cur.length) ?? this.cur.length;
    d = this.ties(d, at);
    const prm = this.params('q', at);
    d = this.ties(d, at);
    const tie = this.consumeTie();
    this.emitNote([pitch], d, at, prm, tie);
  }

  private chord(at: Pos): void {
    const pitches: number[] = [];
    let octave = this.cur.octave;
    for (;;) {
      this.spaces();
      if (this.p >= this.src.length) fail('E_SAKURA_SYNTAX', "和音の閉じ ' がありません。", at);
      const c = this.peek();
      const here = this.at();
      this.p++;
      if (c === "'") break;
      if (c in SEMI) {
        const pitch = this.pitchOf(c, octave, here);
        if (!pitches.includes(pitch)) pitches.push(pitch);
        else this.warn.add('W_SAKURA_CHORD_DUP', '和音の中の同じ音高を 1 つにまとめました。', here);
        if (/[0-9]/.test(this.peek())) {
          this.int();
          this.warn.add('W_SAKURA_CHORD_LEN', '和音の中の個別の音長は無視しました。', here);
        }
      } else if (c === 'o') {
        const o = this.need(this.int(), 'o', here);
        octave = o;
        this.warn.add('W_SAKURA_CHORD_O', '和音の中の o は、和音の中だけで有効として変換しました（推定）。', here);
      } else if (c === '>') octave++;
      else if (c === '<') octave--;
      else if (c === '`') this.oneShot++;
      else if (c === '"') this.oneShot--;
      else if (c === 'n') {
        const no = this.need(this.int(), 'n', here);
        pitches.push(no + this.key + this.cur.trackKey);
      } else if (isUpperStart(c)) {
        // a Str inside a chord (`'OA'`): splice its text in place
        let k = this.p - 1;
        let name = '';
        while (isIdent(this.src[k]?.ch)) name += this.src[k++].ch;
        const v = this.lookupVar(name);
        if (v?.t !== 'str') fail('E_SAKURA_SYNTAX', `和音の中に書けない名前です: ${name}`, here);
        this.src = [...this.src.slice(0, this.p - 1), ...v.chars, ...this.src.slice(k)];
        this.p--;
        if (this.src.length > MAX_EXPANDED) fail('E_SAKURA_LIMIT', '展開後の MML が大きすぎます。', here);
      } else fail('E_SAKURA_SYNTAX', `和音の中に書けない文字です: ${c}`, here);
    }
    if (pitches.length === 0) fail('E_SAKURA_SYNTAX', '和音に音がありません。', at);
    let d = this.length(at, this.cur.length) ?? this.cur.length;
    d = this.ties(d, at);
    const prm = this.params('q', at);
    const tie = this.consumeTie();
    pitches.sort((a, b) => a - b);
    this.emitNote(pitches, d, at, prm, tie);
  }

  private inTuplet = false;
  private tupletOrigin = 0;

  /**
   * Tuplet `{…}n`: the body is interpreted with the normal commands, each note / rest counting
   * as one unit (`^` adds a unit); afterwards the units share the n-th note length exactly.
   */
  private tuplet(at: Pos): void {
    if (this.inTuplet) fail('E_SAKURA_SYNTAX', '連符の入れ子は未対応です。', at);
    this.p++; // {
    const track = this.cur;
    const vtrack = track.vtrack;
    const firstItem = vtrack.items.length;
    const origin = track.cursor;
    this.tupletOrigin = origin;
    this.inTuplet = true;
    try {
      for (;;) {
        this.spaces();
        if (this.p >= this.src.length) fail('E_SAKURA_SYNTAX', '連符 { が } で閉じられていません。', at);
        if (this.peek() === '}') {
          this.p++;
          break;
        }
        this.step();
        if (this.cur !== track || track.vtrack !== vtrack) fail('E_SAKURA_SYNTAX', '連符の中でトラックやチャンネルは変えられません。', at);
      }
    } finally {
      this.inTuplet = false;
    }
    const units = track.cursor - origin;
    if (units <= 0) fail('E_SAKURA_SYNTAX', '連符の中に音がありません。', at);
    const total = this.length(at) ?? track.length;
    const base = Math.floor(total / units);
    const extra = total - base * units;
    // tick of unit boundary u (the first `extra` units are 1 tick longer)
    const tickAt = (u: number) => origin + u * base + Math.min(u, extra);
    if (base <= 0) fail('E_SAKURA_RANGE', '連符の音が短すぎます。', at);
    for (let k = firstItem; k < vtrack.items.length; k++) {
      const it = vtrack.items[k];
      if (it.kind === 'note' || it.kind === 'rest') {
        const u0 = it.start - origin;
        const u1 = u0 + it.duration;
        it.start = tickAt(u0);
        it.duration = tickAt(u1) - it.start;
      } else if (it.kind === 'control') {
        it.tick = tickAt(it.tick - origin);
        it.control = { ...it.control, tick: it.tick };
      }
    }
    track.cursor = origin + total;
  }

  private bend(value: number, at: Pos): void {
    if (value < -8192 || value > 8191) fail('E_SAKURA_RANGE', `ピッチベンド ${value} は範囲外です（-8192〜8191）。`, at);
    this.control({ kind: 'pitchbend', channel: this.cur.vtrack.channel - 1, tick: 0, value }, `PB(${value})`, at);
  }

  private cc(n: number, v: number, at: Pos): void {
    if (n > 127 || v > 127 || n < 0 || v < 0) fail('E_SAKURA_RANGE', `CC(${n},${v}) は範囲外です（0〜127）。`, at);
    this.control({ kind: 'cc', channel: this.cur.vtrack.channel - 1, tick: 0, controller: n, value: v }, `CC(${n},${v})`, at);
  }

  private program(n: number, msb: number | null, lsb: number | null, at: Pos): void {
    if (n < 1 || n > 128) fail('E_SAKURA_RANGE', `@${n} は範囲外です（1〜128）。`, at);
    if (this.cur.vtrack.channel === 10) {
      this.warn.add('W_SAKURA_DRUM_PROGRAM', 'ドラム（チャンネル 10）の音色指定は変換しません。', at);
      return;
    }
    if (msb !== null) this.cc(0, msb, at);
    if (lsb !== null) this.cc(32, lsb, at);
    this.control({ kind: 'program', channel: this.cur.vtrack.channel - 1, tick: 0, program: n - 1 }, `@${n}`, at);
  }

  private measureTick(measure: number): number {
    // measure numbers are 1-based; signatures are assumed to start at measure boundaries
    const sigs = [...this.signatures].sort((a, b) => a.tick - b.tick);
    let tick = 0;
    let num = 4;
    let den = 4;
    let s = 0;
    for (let m = 1; m < measure; m++) {
      while (s < sigs.length && sigs[s].tick <= tick) {
        num = sigs[s].num;
        den = sigs[s].den;
        s++;
      }
      tick += (num * WHOLE) / den;
    }
    return tick;
  }

  private word(at: Pos): void {
    let name = '';
    while (/[A-Za-z0-9_]/.test(this.peek()) || (this.peek() === '.' && /[A-Za-z]/.test(this.peek(1)) && name !== '')) {
      name += this.src[this.p++].ch;
    }
    if (this.statement(name, at)) return;
    const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
    if (name.includes('.') && (IGNORE.has(base) || WARN_SKIP.has(base))) {
      // PlayFrom.SysEx=1 ...
      this.skipArgs();
      if (WARN_SKIP.has(base)) this.warn.add('W_SAKURA_SKIP', `${name} は変換しません。`, at);
      return;
    }
    if (name.includes('.') && base !== 'System') {
      // P.onNoteWave(...), EP.W(...), PitchBend.T(...) ...
      this.skipArgs();
      this.warn.add('W_SAKURA_TIMED', `${name} などの時間変化の指定は変換しません。`, at);
      return;
    }
    const a = () => this.args();
    switch (name) {
      case 'TR':
      case 'TRACK':
      case 'Track': {
        const args = a();
        const n = this.num(args?.[0], name, at);
        this.cur = this.track(n);
        return;
      }
      case 'CH':
      case 'CHANNEL':
      case 'Channel':
        this.setChannel(this.num(a()?.[0], name, at), at);
        return;
      case 'Tempo':
      case 'TEMPO':
      case 'T':
      case 'BPM': {
        const v = a()?.[0];
        const bpm = v === undefined || v.trim() === '' ? NaN : this.evalNum(v, 'テンポ', at);
        if (v === undefined || !Number.isFinite(bpm) || bpm <= 0) fail('E_SAKURA_VALUE', `テンポの値「${v ?? ''}」を読めません。`, at);
        this.song.tempos.push({ tick: this.cur.cursor, us: Math.round(60_000_000 / bpm), bpm: Number.isInteger(bpm) && bpm >= 20 && bpm <= 300 ? bpm : null, at });
        return;
      }
      case 'Time':
      case 'TIME': {
        const args = a() ?? [];
        let tick: number;
        if (args.length >= 3) {
          const m = this.num(args[0], 'Time', at) + this.measureShift;
          const b = this.num(args[1], 'Time', at);
          const s = this.num(args[2], 'Time', at);
          const sig = [...this.signatures].sort((x, y) => x.tick - y.tick).filter((x) => x.tick <= this.measureTick(m)).pop() ?? { num: 4, den: 4 };
          tick = this.measureTick(m) + (b - 1) * (WHOLE / sig.den) + this.stepTicks(s, at);
          if (this.measureShift) this.warn.add('W_SAKURA_MEASURE_SHIFT', 'MeasureShift を考慮して Time の小節番号をずらしました（推定）。', at);
        } else tick = this.stepTicks(this.num(args[0], 'Time', at), at);
        this.cur.cursor = tick;
        return;
      }
      case 'TimeSignature':
      case 'TimeSig':
      case 'TIMESIG':
      case 'System.TimeSignature': {
        const args = a() ?? [];
        const num = this.num(args[0], name, at);
        const den = this.num(args[1], name, at);
        this.signatures.push({ tick: this.cur.cursor, num, den });
        this.song.meta.push({ kind: '拍子', text: `${num}/${den}` });
        return;
      }
      case 'System.MeasureShift':
      case 'MeasureShift':
      case 'MEASURE_SHIFT':
        this.measureShift = this.num(a()?.[0], name, at);
        return;
      case 'System.TimeBase':
      case 'TimeBase':
      case 'Timebase':
      case 'TIMEBASE':
        this.timeBase = this.num(a()?.[0], name, at);
        if (this.timeBase <= 0) fail('E_SAKURA_RANGE', 'TimeBase は 1 以上です。', at);
        return;
      case 'System.vAdd':
        this.vAdd = this.num(a()?.[0], name, at);
        return;
      case 'Sub':
      case 'SUB':
      case 'S': {
        this.blanks();
        if (this.peek() !== '{') fail('E_SAKURA_SYNTAX', 'Sub の後に { が必要です。', at);
        this.p++;
        const start = this.cur.cursor;
        const track = this.cur;
        try {
          for (;;) {
            this.spaces();
            if (this.p >= this.src.length) fail('E_SAKURA_SYNTAX', 'Sub{ が } で閉じられていません。', at);
            if (this.peek() === '}') {
              this.p++;
              break;
            }
            this.step();
          }
        } finally {
          track.cursor = start;
        }
        return;
      }
      case 'Div':
      case 'DIV':
        this.blanks();
        this.tuplet(at);
        return;
      case 'Voice':
      case 'VOICE': {
        const args = a() ?? [];
        this.program(this.num(args[0], name, at), args[1] ? this.num(args[1], name, at) : null, args[2] ? this.num(args[2], name, at) : null, at);
        return;
      }
      case 'CC':
      case 'ControlChange':
      case 'CONTROL_CHANGE': {
        const args = a() ?? [];
        this.cc(this.num(args[0], name, at), this.num(args[1], name, at), at);
        return;
      }
      case 'PB':
      case 'PitchBend':
        this.bend(this.num(a()?.[0], name, at), at);
        return;
      case 'BR':
      case 'BendRange':
      case 'BEND_RANGE':
      case 'PitchBendSensitivity': {
        const v = this.num(a()?.[0], name, at);
        this.cc(101, 0, at);
        this.cc(100, 0, at);
        this.cc(6, v, at);
        return;
      }
      case 'Key':
      case 'KEY':
      case 'KeyShift':
      case 'KEY_SHIFT':
        this.key = this.num(a()?.[0], name, at);
        return;
      case 'TrackKey':
      case 'TR_KEY':
        this.cur.trackKey = this.num(a()?.[0], name, at);
        return;
      case 'KeyFlag':
      case 'KF':
      case 'System.KeyFlag':
        this.keyflag(at);
        return;
      case 'TrackSync':
      case 'TRACK_SYNC': {
        const max = Math.max(...[...this.tracks.values()].map((t) => t.cursor));
        for (const t of this.tracks.values()) t.cursor = max;
        return;
      }
      case 'End':
      case 'END':
        this.ended = true;
        return;
      case 'SysEx':
      case 'SYSEX':
      case 'SysEx$':
        this.sysex(at);
        return;
    }
    if (META.has(name)) {
      const v = a()?.[0] ?? '';
      this.song.meta.push({ kind: META.get(name)!, text: v.replace(/^"|"$/g, '') });
      return;
    }
    if (name in CC_COMMANDS) {
      const args = a();
      this.cc(CC_COMMANDS[name], this.num(args?.[0], name, at), at);
      return;
    }
    if (IGNORE.has(name)) {
      this.blanks();
      if (this.peek() === '(' || this.peek() === '=') this.skipArgs();
      return;
    }
    if (WARN_SKIP.has(name)) {
      this.blanks();
      if (this.peek() === '(' || this.peek() === '=') this.skipArgs();
      this.warn.add('W_SAKURA_SKIP', `${name} は変換しません。`, at);
      return;
    }
    if (RHYTHM_WORDS.includes(name) || name === 'R') fail('E_SAKURA_SYNTAX', `${name} の後に { … } が必要です。`, at);
    if (UNSUPPORTED.has(name) || /^(GS|XG)/.test(name)) {
      this.blanks();
      if (this.peek() === '(' || (this.peek() === '=' && this.peek(1) !== '=')) this.skipArgs();
      if (/^(Include|INCLUDE|System\.Include)$/.test(name)) {
        this.includeSeen = true;
        this.unsupported(`${name} は未対応です（読み込むファイルの内容が分からないため、そのファイルで定義された命令は再現できません）。`, at);
      } else this.unsupported(`${name} は未対応です（プログラム機能など）。`, at);
      return;
    }
    this.unknownName(name, at);
  }

  /** A name that is neither a command nor defined in the pasted text. */
  private unknownName(name: string, at: Pos): void {
    this.blanks();
    let args: SChar[][] | null = null;
    if (this.peek() === '(') args = splitTop(this.parenChars(), ',').map(trimChars);
    else if (this.peek() === '=' && this.peek(1) !== '=') {
      this.p++;
      this.readExprChars();
    }
    const hint = this.includeSeen ? '（Include したファイルで定義されている可能性があります）' : '';
    if (!this.bestEffort) fail('E_SAKURA_UNKNOWN', `不明な命令または未定義の名前です: ${name}${hint}`, at);
    const first = args?.[0];
    if (first && isBraced(first)) {
      this.skipped(`${name}(…) は定義が分からないため、最初の引数 {…} の MML を 1 回だけ演奏しました（${name} 自体の効果は再現しません）。${hint}`, at, '（近似変換）');
      this.exec(first.slice(1, -1));
    } else this.skipped(`不明な命令または未定義の名前 ${name} を読み飛ばしました。${hint}`, at, '（近似変換）');
  }

  /* ---------------------------------------------------------- program statements (SPEC 4.5.12) */

  /** Int / Str / Function / If / For / While / user functions / variables. true when handled. */
  private statement(name: string, at: Pos): boolean {
    if (KEYWORDS_INT.has(name)) {
      this.declInt(at);
      return true;
    }
    if (KEYWORDS_STR.has(name)) {
      this.declStr(at);
      return true;
    }
    switch (name) {
      case 'Array':
      case 'ARRAY':
        this.skipStatement();
        this.unsupported('Array（配列）は未対応です。', at);
        return true;
      case 'Function':
      case 'FUNCTION':
        this.defineFunction(at);
        return true;
      case 'If':
      case 'IF':
        this.ifStatement(at);
        return true;
      case 'For':
      case 'FOR':
        this.forStatement(at, false);
        return true;
      case 'While':
      case 'WHILE':
        this.forStatement(at, true);
        return true;
      case 'Return':
      case 'RETURN':
      case 'Result':
        this.blanks();
        if (this.peek() === '(') this.parenChars();
        throw new ReturnSignal();
      case 'Break':
      case 'BREAK':
        throw new BreakSignal();
      case 'Continue':
      case 'CONTINUE':
        throw new ContinueSignal();
      case 'Exit':
      case 'EXIT':
        this.ended = true;
        return true;
      case 'Else':
      case 'ELSE':
        fail('E_SAKURA_SYNTAX', 'If の無い Else です。', at);
    }
    const f = this.funcs.get(name);
    if (f) {
      this.callFunction(f, at);
      return true;
    }
    const v = this.lookupVar(name);
    if (!v) return false;
    this.blanks();
    const c = this.peek();
    const n = this.peek(1);
    if (v.t === 'int' && ((c === '+' && n === '+') || (c === '-' && n === '-'))) {
      this.p += 2;
      this.setVar(name, { t: 'int', v: v.v + (c === '+' ? 1 : -1) }, false);
    } else if (v.t === 'int' && '+-*/'.includes(c) && c !== '' && n === '=') {
      this.p += 2;
      const e = textOf(this.readExprChars());
      this.setVar(name, { t: 'int', v: Math.trunc(this.evalNum(`(${name})${c}(${e})`, name, at)) }, false);
    } else if (c === '=' && n !== '=') {
      this.p++;
      if (v.t === 'int') this.setVar(name, { t: 'int', v: Math.trunc(this.evalNum(textOf(this.readExprChars()), name, at)) }, false);
      else this.setVar(name, { t: 'str', chars: this.strValue(at) }, false);
    } else if (v.t === 'str') {
      this.exec(v.chars);
    } else {
      this.warn.add('W_SAKURA_BARE_INT', `Int 変数 ${name} が単独で書かれているため無視しました。`, at);
    }
    return true;
  }

  /** skip to the end of the statement (`;` or the end of the line) */
  private skipStatement(): void {
    let depth = 0;
    while (this.p < this.src.length) {
      const c = this.src[this.p];
      if (!c.str) {
        if (c.ch === '(' || c.ch === '{') depth++;
        else if (c.ch === ')' || c.ch === '}') {
          if (depth === 0) return;
          depth--;
        } else if (depth === 0 && (c.ch === ';' || c.ch === '\n')) return;
      }
      this.p++;
    }
  }

  private ident(): string {
    this.blanks();
    let name = '';
    while (/[A-Za-z0-9_]/.test(this.peek()) && (name !== '' || /[A-Za-z_]/.test(this.peek()))) name += this.src[this.p++].ch;
    return name;
  }

  private declInt(at: Pos): void {
    for (;;) {
      const name = this.ident();
      if (!name) fail('E_SAKURA_SYNTAX', 'Int の後に変数名が必要です。', at);
      this.blanks();
      let v = 0;
      if (this.peek() === '=' && this.peek(1) !== '=') {
        this.p++;
        v = Math.trunc(this.evalNum(textOf(this.readExprChars()), `Int ${name}`, at));
      }
      this.setVar(name, { t: 'int', v }, true);
      this.blanks();
      if (this.peek() === ',' && /[A-Za-z_ ]/.test(this.peek(1))) {
        this.p++;
        continue;
      }
      return;
    }
  }

  private declStr(at: Pos): void {
    const name = this.ident();
    if (!name) fail('E_SAKURA_SYNTAX', 'Str の後に変数名が必要です。', at);
    this.blanks();
    let chars: SChar[] = [];
    if (this.peek() === '=' && this.peek(1) !== '=') {
      this.p++;
      chars = this.strValue(at);
    }
    this.setVar(name, { t: 'str', chars }, true);
  }

  /** after `Str X=`: `{…}` or another Str */
  private strValue(at: Pos): SChar[] {
    this.blanks();
    let chars: SChar[] | null = null;
    if (this.peek() === '{') chars = this.braceChars();
    else if (isUpperStart(this.peek())) {
      const save = this.p;
      const v = this.lookupVar(this.ident());
      if (v?.t === 'str') chars = v.chars;
      else this.p = save;
    }
    if (chars === null) {
      this.readExprChars();
      fail('E_SAKURA_UNSUPPORTED', `Str の値が {…} 以外（式など）の場合は未対応です。${MIDI_HINT}`, at);
    }
    this.blanks();
    if (this.peek() === '+') {
      this.p++;
      this.readExprChars();
      fail('E_SAKURA_UNSUPPORTED', `文字列の連結は未対応です。${MIDI_HINT}`, at);
    }
    return chars;
  }

  private defineFunction(at: Pos): void {
    const name = this.ident();
    if (!name) fail('E_SAKURA_SYNTAX', 'Function の後に関数名が必要です。', at);
    this.blanks();
    const params: Param[] = [];
    if (this.peek() === '(') {
      for (const raw of splitTop(this.parenChars(), ',')) {
        const t = textOf(raw).trim();
        if (!t) continue;
        const m = /^(?:(Str|STR|Int|INT|Array|ARRAY)\s+)?([A-Za-z_]\w*)\s*(?:=\s*([\s\S]*))?$/.exec(t);
        if (!m) fail('E_SAKURA_SYNTAX', `関数 ${name} の引数「${t}」を読めません。`, at);
        params.push({ name: m[2], type: m[1] && /^s/i.test(m[1]) ? 'str' : m[1] && /^i/i.test(m[1]) ? 'int' : 'any', def: m[3]?.trim() });
      }
    }
    this.spaces();
    if (this.peek() !== '{') fail('E_SAKURA_SYNTAX', `関数 ${name} の本体 { … } がありません。`, at);
    this.funcs.set(name, { name, params, body: this.braceChars() });
  }

  private callFunction(f: FuncDef, at: Pos): void {
    this.blanks();
    let args: SChar[][] = [];
    if (this.peek() === '(') {
      args = splitTop(this.parenChars(), ',').map(trimChars);
      if (args.length === 1 && args[0].length === 0) args = [];
    } else if (this.peek() === '=' && this.peek(1) !== '=') {
      this.p++;
      args = [trimChars(this.readExprChars())];
      while (this.peek() === ',' && /[0-9A-Za-z_($+{-]/.test(this.peek(1))) {
        this.p++;
        args.push(trimChars(this.readExprChars()));
      }
    }
    // arguments are evaluated in the caller's scope
    const scope = new Map<string, Var>();
    f.params.forEach((pm, i) => {
      let a = args[i];
      if (!a || a.length === 0) {
        if (pm.def === undefined) {
          scope.set(pm.name, pm.type === 'str' ? { t: 'str', chars: [] } : { t: 'int', v: 0 });
          return;
        }
        a = charsOf(pm.def, at);
      }
      scope.set(pm.name, this.argValue(a, pm.type, `${f.name} の引数 ${pm.name}`, at));
    });
    if (++this.callDepth > MAX_CALL_DEPTH) fail('E_SAKURA_LIMIT', `関数の呼び出しが ${MAX_CALL_DEPTH} 段を超えました（再帰している可能性があります）。`, at);
    this.scopes.push(scope);
    try {
      this.exec(f.body);
    } catch (e) {
      if (!(e instanceof ReturnSignal)) throw e;
    } finally {
      this.scopes.pop();
      this.callDepth--;
    }
  }

  private argValue(a: SChar[], type: Param['type'], what: string, at: Pos): Var {
    if (isBraced(a)) return { t: 'str', chars: a.slice(1, -1) };
    const text = textOf(a).trim();
    if (/^[A-Za-z_]\w*$/.test(text)) {
      const v = this.lookupVar(text);
      if (v?.t === 'str' && type !== 'int') return v;
    }
    if (type === 'str') return { t: 'str', chars: a };
    if (type === 'int') return { t: 'int', v: Math.trunc(this.evalNum(text, what, at)) };
    // untyped: a number when it evaluates to one, otherwise the text itself
    try {
      const v = this.evalValue(text, what, at);
      if (typeof v === 'number') return { t: 'int', v: Math.trunc(v) };
    } catch (e) {
      if (!(e instanceof DialectError)) throw e;
    }
    return { t: 'str', chars: a };
  }

  /** evaluates a condition; null when it cannot be decided at conversion time */
  private condition(chars: SChar[], at: Pos): boolean | null {
    try {
      return truthy(this.evalValue(textOf(chars), '条件', at));
    } catch (e) {
      if (!(e instanceof DialectError)) throw e;
      this.unsupported(`条件「${textOf(chars).trim()}」を変換時に決められないため、この If / For / While を実行しません。`, at);
      return null;
    }
  }

  private ifStatement(at: Pos): void {
    const branches: Array<{ cond: SChar[] | null; body: SChar[] }> = [];
    for (;;) {
      this.blanks();
      if (this.peek() !== '(') fail('E_SAKURA_SYNTAX', 'If の後に (条件) が必要です。', at);
      const cond = this.parenChars();
      this.spaces();
      if (this.peek() !== '{') fail('E_SAKURA_SYNTAX', 'If (条件) の後に { … } が必要です。', at);
      branches.push({ cond, body: this.braceChars() });
      const save = this.p;
      this.spaces();
      const w = this.ident();
      if (w === 'Else' || w === 'ELSE') {
        this.spaces();
        const save2 = this.p;
        const w2 = this.ident();
        if (w2 === 'If' || w2 === 'IF') continue;
        this.p = save2;
        if (this.peek() !== '{') fail('E_SAKURA_SYNTAX', 'Else の後に { … } が必要です。', at);
        branches.push({ cond: null, body: this.braceChars() });
      } else this.p = save;
      break;
    }
    for (const b of branches) {
      if (b.cond === null) {
        this.exec(b.body);
        return;
      }
      const ok = this.condition(b.cond, at);
      if (ok === null) return; // undecidable: the whole If is skipped (best-effort)
      if (ok) {
        this.exec(b.body);
        return;
      }
    }
  }

  /** For(init; cond; step){…} / While(cond){…} */
  private forStatement(at: Pos, isWhile: boolean): void {
    this.blanks();
    if (this.peek() !== '(') fail('E_SAKURA_SYNTAX', `${isWhile ? 'While' : 'For'} の後に ( … ) が必要です。`, at);
    const header = this.parenChars();
    this.spaces();
    if (this.peek() !== '{') fail('E_SAKURA_SYNTAX', `${isWhile ? 'While' : 'For'} ( … ) の後に { … } が必要です。`, at);
    const body = this.braceChars();
    let init: SChar[] = [];
    let cond: SChar[];
    let step: SChar[] = [];
    if (isWhile) cond = header;
    else {
      const parts = splitTop(header, ';');
      if (parts.length !== 3) fail('E_SAKURA_SYNTAX', 'For は For(初期化; 条件; 更新) の形で書いてください。', at);
      [init, cond, step] = parts;
    }
    if (textOf(init).trim()) this.simpleStatement(textOf(init), at);
    for (let n = 0; ; n++) {
      if (n >= MAX_LOOP) fail('E_SAKURA_LIMIT', `繰り返しが ${MAX_LOOP} 回を超えました（無限ループの可能性があります）。`, at);
      if (textOf(cond).trim()) {
        const ok = this.condition(cond, at);
        if (ok === null || !ok) return;
      }
      try {
        this.exec(body);
      } catch (e) {
        if (e instanceof BreakSignal) return;
        if (!(e instanceof ContinueSignal)) throw e;
      }
      if (textOf(step).trim()) this.simpleStatement(textOf(step), at);
    }
  }

  /** `Int A=0`, `A=A+1`, `A++`, `A+=2` (For headers) */
  private simpleStatement(text: string, at: Pos): void {
    const t = text.trim();
    let m = /^(?:(Int|INT)\s+)?([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(t);
    if (m && !(m[3] === undefined && !m[1])) {
      const v = m[3] === undefined ? 0 : Math.trunc(this.evalNum(m[3], m[2], at));
      this.setVar(m[2], { t: 'int', v }, !!m[1] || !this.lookupVar(m[2]));
      return;
    }
    m = /^([A-Za-z_]\w*)\s*(\+\+|--)$/.exec(t) ?? /^(\+\+|--)\s*([A-Za-z_]\w*)$/.exec(t);
    if (m) {
      const name = m[1].startsWith('+') || m[1].startsWith('-') ? m[2] : m[1];
      const op = m[1].startsWith('+') || m[1].startsWith('-') ? m[1] : m[2];
      const cur = this.evalNum(name, name, at);
      this.setVar(name, { t: 'int', v: cur + (op === '++' ? 1 : -1) }, false);
      return;
    }
    m = /^([A-Za-z_]\w*)\s*([+\-*/])=\s*([\s\S]+)$/.exec(t);
    if (m) {
      this.setVar(m[1], { t: 'int', v: Math.trunc(this.evalNum(`(${m[1]})${m[2]}(${m[3]})`, m[1], at)) }, false);
      return;
    }
    fail('E_SAKURA_SYNTAX', `「${t}」を読めません（For の初期化・更新に書けるのは Int A=0、A++、A+=1 などです）。`, at);
  }

  /** SysEx: only GS "Use for Rhythm Part" is used (the channel becomes a drum channel). */
  private sysex(at: Pos): void {
    this.blanks();
    let raw: SChar[];
    if (this.peek() === '(') raw = this.parenChars();
    else {
      if (this.peek() === '=') this.p++;
      const start = this.p;
      this.skipStatement();
      raw = this.src.slice(start, this.p);
    }
    const items: SChar[][] = [];
    for (const it of splitTop(raw, ',').map(trimChars)) {
      if (isBraced(it)) items.push(...splitTop(it.slice(1, -1), ',').map(trimChars));
      else items.push(it);
    }
    let bytes: number[];
    try {
      bytes = items.map((x) => this.evalNum(textOf(x), 'SysEx', at));
    } catch (e) {
      if (!(e instanceof DialectError)) throw e;
      this.unsupported('SysEx の内容を変換時に求められないため、変換しません。', at);
      return;
    }
    const [f0, maker, , model, cmd, a1, a2, a3, value] = bytes;
    if (f0 === 0xf0 && maker === 0x41 && model === 0x42 && cmd === 0x12 && a1 === 0x40 && (a2 & 0xf0) === 0x10 && a3 === 0x15 && value !== undefined) {
      const part = a2 & 0x0f;
      const ch = part === 0 ? 10 : part <= 9 ? part : part + 1;
      if (ch !== 10) {
        if (value > 0) this.song.drumChannels.set(ch, at);
        else this.song.drumChannels.delete(ch);
      }
      return;
    }
    this.unsupported('SysEx は変換しません（読み取るのは GS の Use for Rhythm Part だけです）。', at);
  }

  private keyflag(at: Pos): void {
    this.blanks();
    const c = this.peek();
    if (c === '=') {
      this.p++;
      this.blanks();
      const args = this.args() ?? [];
      // `KeyFlag=(a,b,c,d,e,f,g)` with +1 / -1 / 0
      args.forEach((v, i) => {
        if (i < 7) this.keyFlag.set(KEYFLAG_ORDER[i], this.num(v, 'KeyFlag', at));
      });
      this.warn.add('W_SAKURA_KEYFLAG', 'KeyFlag の数値は +1 = シャープ、-1 = フラットとして変換しました（推定）。', at);
      return;
    }
    if (c === '+' || c === '#' || c === '-') {
      this.p++;
      const sign = c === '-' ? -1 : 1;
      this.blanks();
      if (this.peek() !== '(') fail('E_SAKURA_SYNTAX', 'KeyFlag+(音名) の形で書いてください。', at);
      this.p++;
      while (this.p < this.src.length && this.peek() !== ')') {
        const ch = this.src[this.p++].ch;
        if (ch in SEMI) this.keyFlag.set(ch, sign);
      }
      this.p++;
      return;
    }
    fail('E_SAKURA_SYNTAX', 'KeyFlag の書き方が正しくありません。', at);
  }
}

/* ================================================================== 8. output */

interface Built {
  mml: string;
  expected: CanonSong;
  notes: number;
  tracks: number;
}

function writeSong(song: Song, warn: Warnings, approximate: boolean): Built {
  const out: string[] = [];
  const title = song.meta.find((m) => m.kind === '曲名')?.text;
  out.push(`// picosakura から変換${title ? `: ${title.replace(/[\r\n]/g, ' ')}` : ''}`);
  if (approximate) out.push('// 近似変換: 変換できない命令をスキップしています（元の曲と同じには鳴りません）。');

  // GS rhythm parts (Use for Rhythm Part SysEx): played on the GM drum channel 10
  for (const [ch, at] of song.drumChannels) {
    let dropped = 0;
    for (const v of song.vtracks) {
      if (v.channel !== ch) continue;
      v.channel = 10;
      const before = v.items.length;
      v.items = v.items.filter((it) => !(it.kind === 'control' && (it.control.kind === 'program' || (it.control.kind === 'cc' && (it.control.controller === 0 || it.control.controller === 32)))));
      dropped += before - v.items.length;
    }
    warn.add('I_SAKURA_GS_RHYTHM', `GS の SysEx（Use for Rhythm Part）により、チャンネル ${ch} をドラムとしてチャンネル 10 にまとめました${dropped ? '（ドラムセットの指定は変換しません）' : ''}。`, at);
  }
  for (const m of song.meta.filter((x) => x.kind !== '曲名')) out.push(`// ${m.kind}: ${m.text.replace(/[\r\n]/g, ' ')}`);
  out.push('// オクターブはサクラの o から 1 を引いています（サクラ o5c = MML Studio o4c = MIDI 60）。');
  out.push('// 行末の // の後の数字は元の行番号です。');
  out.push('');

  // tempo (global)
  const tempoByTick = new Map<number, (typeof song.tempos)[number]>();
  for (const t of song.tempos) {
    const prev = tempoByTick.get(t.tick);
    if (prev && prev.us !== t.us) warn.add('W_SAKURA_TEMPO', `同じ位置に異なるテンポがあるため、後の指定を使いました（テンポは曲全体で共通）。`, t.at);
    tempoByTick.set(t.tick, t);
  }
  const tempos = [...tempoByTick.values()].sort((a, b) => a.tick - b.tick);
  out.push('TR(0)');
  for (const t of tempos) out.push(`${timeOf(t.tick)} ${t.bpm !== null ? `Tempo(${t.bpm})` : `TempoUS(${t.us})`}`);

  // group virtual tracks by channel (first appearance order)
  const groups: Array<{ channel: number; vtracks: VTrack[] }> = [];
  for (const v of song.vtracks) {
    if (!v.items.some((i) => i.kind === 'note' || i.kind === 'control')) continue;
    let g = groups.find((x) => x.channel === v.channel);
    if (!g) groups.push((g = { channel: v.channel, vtracks: [] }));
    g.vtracks.push(v);
  }

  const expectedChannels: CanonChannel[] = [];
  let noteCount = 0;
  groups.forEach((g, gi) => {
    const tr = gi + 1;
    const ch = g.channel - 1;
    const notes: CanonNote[] = [];
    const controls: CanonControl[] = [];
    const lines: string[] = [];
    lines.push('');
    lines.push(`// チャンネル ${g.channel}${g.channel === 10 ? '（GM ドラム）' : ''} ← サクラのトラック ${g.vtracks.map((v) => v.id).join(', ')}`);
    let tokens: string[] = [`TR(${tr})`, `CH(${g.channel})`];
    let srcLine = 0;
    const flush = () => {
      if (tokens.length) lines.push(srcLine ? `${tokens.join(' ')}  // ${srcLine}` : tokens.join(' '));
      tokens = [];
    };
    let cursor = 0;
    let octave: number | null = null;
    let defLen: number = PPQ;
    let velocity = 100;
    let gate: GateSpec = { mode: 'percent', value: 90 };
    g.vtracks.forEach((v, vi) => {
      if (vi > 0) {
        flush();
        lines.push(`// （サクラのトラック ${v.id}）`);
      }
      for (const it of v.items) {
        const line = it.line;
        if (line !== srcLine) {
          flush();
          srcLine = line;
        }
        const start = it.kind === 'control' ? it.tick : it.kind === 'length' ? cursor : it.start;
        if (it.kind !== 'length' && start !== cursor) {
          tokens.push(timeOf(start));
          cursor = start;
        }
        switch (it.kind) {
          case 'length': {
            const s = singleToken(it.ticks);
            tokens.push(s ? `l${s}` : `l%${it.ticks}`);
            defLen = it.ticks;
            break;
          }
          case 'control':
            tokens.push(it.text);
            controls.push({ ...it.control, channel: ch, tick: it.tick });
            break;
          case 'rest': {
            if (it.duration === defLen) tokens.push('r');
            else {
              const parts = lengthParts(it.duration);
              tokens.push(parts ? parts.map((x) => `r${x}`).join('') : `r%${it.duration}`);
            }
            cursor += it.duration;
            break;
          }
          case 'note': {
            let t = '';
            if (it.velocity !== velocity) {
              t += `v${it.velocity} `;
              velocity = it.velocity;
            }
            if (it.gate.mode !== gate.mode || it.gate.value !== gate.value) {
              t += it.gate.mode === 'percent' ? `q${it.gate.value} ` : `q%${it.gate.value} `;
              gate = it.gate;
            }
            const len =
              it.duration === defLen
                ? ''
                : (singleToken(it.duration) ?? (lengthParts(it.duration)?.join('^') || `%${it.duration}`));
            const named = it.pitches.every((p) => p >= 12);
            if (it.pitches.length === 1 && named) {
              const p = it.pitches[0];
              const o = Math.floor(p / 12) - 1;
              if (octave === null || Math.abs(o - octave) > 1) t += `o${o} `;
              else if (o === octave + 1) t += '>';
              else if (o === octave - 1) t += '<';
              octave = o;
              t += NOTE_NAMES[p % 12] + len;
            } else if (it.pitches.length === 1) {
              t += `n${it.pitches[0]}%${it.duration}`;
            } else if (named) {
              const o0 = Math.floor(it.pitches[0] / 12) - 1;
              if (octave === null || o0 !== octave) t += `o${o0} `;
              octave = o0;
              let o = o0;
              let inner = '';
              for (const p of it.pitches) {
                const target = Math.floor(p / 12) - 1;
                while (o < target) {
                  inner += '>';
                  o++;
                }
                while (o > target) {
                  inner += '<';
                  o--;
                }
                inner += NOTE_NAMES[p % 12];
              }
              t += `'${inner}'${len.includes('^') ? `%${it.duration}` : len}`;
            } else {
              t += `'${it.pitches.map((p) => `n${p}`).join(' ')}'${len.includes('^') ? `%${it.duration}` : len}`;
            }
            tokens.push(t);
            const g2 = it.gate.mode === 'percent' ? gateOf(it.duration, it.gate.value) : it.gate.value;
            if (g2 > 0 && it.velocity > 0) {
              for (const p of it.pitches) notes.push({ channel: ch, pitch: p, velocity: it.velocity, startTick: it.start, endTick: it.start + g2 });
            }
            noteCount += it.pitches.length;
            cursor += it.duration;
            break;
          }
        }
      }
    });
    flush();

    // same channel + pitch overlapping: exact-tick output for this channel
    const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.startTick - b.startTick);
    let overlap = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].pitch === sorted[i - 1].pitch && sorted[i].startTick < sorted[i - 1].endTick) overlap = true;
    }
    if (overlap) {
      warn.add('W_SAKURA_OVERLAP', `チャンネル ${g.channel} で同じ音高の音が重なるため、このチャンネルは正確な tick の書式で出力し、重なった音は次の音の直前で終わらせました。`, { line: 1, column: 1 });
      const fixed: CanonNote[] = [];
      for (const n of sorted) {
        const prev = fixed[fixed.length - 1];
        if (prev && prev.pitch === n.pitch && n.startTick < prev.endTick) {
          if (n.startTick === prev.startTick) {
            prev.endTick = Math.max(prev.endTick, n.endTick);
            continue;
          }
          prev.endTick = n.startTick;
        }
        fixed.push({ ...n });
      }
      const canon: CanonChannel = { channel: ch, notes: fixed.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch), controls, sourceTracks: [] };
      out.push(...exactTicksTrackLines(canon, tr, `// チャンネル ${g.channel} ← サクラのトラック ${g.vtracks.map((v) => v.id).join(', ')}（正確な tick で出力）`));
      expectedChannels.push(canon);
    } else {
      out.push(...lines);
      expectedChannels.push({ channel: ch, notes, controls, sourceTracks: [] });
    }
  });

  return {
    mml: out.join('\n') + '\n',
    expected: { channels: expectedChannels, tempos: tempos.map((t) => ({ tick: t.tick, microsecondsPerQuarter: t.bpm !== null ? Math.round(60_000_000 / t.bpm) : t.us })), endTick: 0 },
    notes: noteCount,
    tracks: groups.length,
  };
}

/* ================================================================== public API */

function preprocess(text: string, warn: Warnings): { chars: SChar[]; defs: Defs } {
  const defs: Defs = { macros: new Map(), strs: new Map(), ints: new Map(), rhythm: new Map(), meta: [] };
  let chars = toChars(text);
  chars = stripComments(chars);
  chars = normalizeWidth(chars);
  chars = replaceJapanese(chars, warn);
  chars = expand(chars, defs, 0, warn);
  chars = expandRhythm(chars, defs);
  chars = expandLoops(chars, literalInts(chars));
  return { chars, defs };
}

export function listSakuraSongs(text: string): DialectSong[] {
  const m = /(?:TrackName|曲名)\s*=?\s*\{\s*(?:"([^"]*)"|([^}"]*))\s*\}/.exec(text);
  const title = (m?.[1] ?? m?.[2])?.trim();
  return text.trim() ? [{ index: 0, title: title || undefined, startLine: 1, parts: 0 }] : [];
}

export function convertSakura(text: string, options: { bestEffort?: boolean } = {}): DialectConvertResult {
  try {
    if (text.trim() === '') fail('E_SAKURA_NO_DATA', '変換する MML がありません。', { line: 1, column: 1 });
    const warn = new Warnings();
    const { chars, defs } = preprocess(text, warn);
    const interp = new Interpreter(chars, warn, defs.meta, options.bestEffort ?? false);
    interp.run();
    const built = writeSong(interp.song, warn, interp.approximate);
    if (built.notes === 0) fail('E_SAKURA_NO_DATA', '演奏する音符がありません。', { line: 1, column: 1 });
    const compiled = compileMml(built.mml);
    if (!compiled.ok) {
      const d = compiled.diagnostics[0];
      return { ok: false, errors: [{ code: 'E_SAKURA_VERIFY', message: `変換結果の MML がコンパイルできませんでした（${d.code}: ${d.message}）。`, line: 1, column: 1 }] };
    }
    const report = compareMidiEvents(built.expected, compiled.song);
    if (!report.ok) {
      return { ok: false, errors: [{ code: 'E_SAKURA_VERIFY', message: `変換結果を再コンパイルしたイベントが変換器の想定と一致しませんでした（${report.mismatches[0] ?? ''}）。`, line: 1, column: 1 }] };
    }
    return { ok: true, mml: built.mml, warnings: warn.list(), summary: { dialect: 'sakura', parts: built.tracks, notes: built.notes, verified: true, approximate: interp.approximate } };
  } catch (e) {
    if (e instanceof DialectError) return { ok: false, errors: [e.issue] };
    throw e;
  }
}
