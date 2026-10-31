// A small subset of Microsoft-style BASIC (MSX-BASIC / N88-BASIC) for music listings (SPEC 4.5.14).
// It runs the program far enough to collect what PLAY statements play: string variables and
// concatenation, READ / DATA, FOR / NEXT, GOTO / GOSUB, IF / THEN / ELSE, ON ... GOTO.
// Hand-written; nothing is executed outside this interpreter.

/** One character of a string value, with where it came from in the pasted text. */
export interface BChar {
  ch: string;
  line: number;
  column: number;
  /** BASIC line number of the source line ('' when the line has none) */
  label: string;
}
export type BStr = BChar[];
type Value = number | BStr;

export interface Pos {
  line: number;
  column: number;
}

export interface PlayCall {
  /** `PLAY` / `CMD PLAY` */
  command: string;
  /** `#n` (null when omitted) */
  device: number | null;
  /** string arguments; null = empty (`PLAY "A",,"C"`) */
  args: Array<BStr | null>;
  at: Pos;
  label: string;
}

export interface CallStatement {
  /** upper-case name: `MUSIC`, `VOICE`, ... (`CALL MUSIC` and `_MUSIC`) */
  name: string;
  /** evaluated arguments; `@n` gives { voice: n }; null for an empty argument */
  args: Array<number | { voice: number } | null>;
  at: Pos;
  label: string;
}

export interface BasicOptions {
  /** significant characters of a variable name (MSX: 2) */
  nameLength?: number;
  /** `CMD` is a statement prefix (`CMD PLAY`) on N88 */
  cmdPrefix?: boolean;
  bestEffort?: boolean;
  onPlay(call: PlayCall, vars: (name: string) => Value | undefined): void;
  onCall?(call: CallStatement): void;
  warn(code: string, message: string, at: Pos): void;
}

export class BasicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly at: Pos,
  ) {
    super(message);
  }
}

function fail(code: string, message: string, at: Pos): never {
  throw new BasicError(code, message, at);
}

/* ------------------------------------------------------------------ tokens */

type Tok =
  | { t: 'num'; v: number; at: Pos }
  | { t: 'str'; v: BStr; at: Pos }
  | { t: 'kw'; v: string; at: Pos }
  | { t: 'id'; v: string; at: Pos }
  | { t: 'op'; v: string; at: Pos }
  | { t: 'raw'; v: BStr; at: Pos }; // DATA items / REM text

const KEYWORDS = [
  'PLAY',
  'CMD',
  'CALL',
  'FOR',
  'TO',
  'STEP',
  'NEXT',
  'GOTO',
  'GOSUB',
  'RETURN',
  'IF',
  'THEN',
  'ELSE',
  'ON',
  'READ',
  'DATA',
  'RESTORE',
  'END',
  'STOP',
  'REM',
  'LET',
  'DIM',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'MOD',
  'PRINT',
  'CLS',
  'SCREEN',
  'COLOR',
  'WIDTH',
  'LOCATE',
  'BEEP',
  'SOUND',
  'KEY',
  'DEFINT',
  'DEFSNG',
  'DEFDBL',
  'DEFSTR',
  'CLEAR',
  'INPUT',
  'INKEY$',
  'CHR$',
  'STR$',
  'LEFT$',
  'RIGHT$',
  'MID$',
  'STRING$',
  'SPACE$',
  'LEN',
  'VAL',
  'ASC',
  'INT',
  'ABS',
  'SGN',
  'FIX',
  'RND',
  'POKE',
  'OUT',
  'WAIT',
  'BGM',
  'STOPM',
  'VOICE',
  'NEW',
  'CONSOLE',
  'RANDOMIZE',
  'SWAP',
  'ERASE',
  'PSET',
  'PRESET',
  'LINE',
  'CIRCLE',
  'PAINT',
  'DEF',
  'USR',
  'TIME',
  'INTERVAL',
  'OFF',
  'MAXFILES',
  'OPEN',
  'CLOSE',
  'VPOKE',
  'SPRITE',
  'PUT',
  'GET',
  'TRON',
  'TROFF',
  'ERROR',
  'RESUME',
  'HEX$',
  'OCT$',
  'BIN$',
  'PEEK',
  'INP',
  'STRIG',
  'STICK',
  'GO',
  'LIST',
  'RUN',
  'AUTO',
  'DELETE',
  'RENUM',
  'CSRLIN',
  'POS',
  'TAB',
  'SPC',
  'USING',
  'BLOAD',
  'BSAVE',
  'LOAD',
  'SAVE',
  'MERGE',
  'FILES',
  'KILL',
  'NAME',
  'ATTR$',
  'COPY',
  'SET',
  'MON',
  'TERM',
  'VIEW',
  'WINDOW',
  'PALETTE',
  'FIELD',
  'LSET',
  'RSET',
  'WRITE',
  'LPRINT',
  'LLIST',
  'HELP',
  'SLEEP',
].sort((a, b) => b.length - a.length);

/** statements that do not affect the music: skipped without a warning */
const IGNORED = new Set([
  'PRINT',
  'CLS',
  'SCREEN',
  'COLOR',
  'WIDTH',
  'LOCATE',
  'KEY',
  'DEFINT',
  'DEFSNG',
  'DEFDBL',
  'CLEAR',
  'DIM',
  'CONSOLE',
  'RANDOMIZE',
  'ERASE',
  'PSET',
  'PRESET',
  'LINE',
  'CIRCLE',
  'PAINT',
  'DEF',
  'INTERVAL',
  'MAXFILES',
  'VPOKE',
  'SPRITE',
  'PUT',
  'GET',
  'TRON',
  'TROFF',
  'BGM',
  'STOPM',
  'VOICE',
  'NEW',
  'TIME',
  'OPEN',
  'CLOSE',
  'SET',
  'COPY',
  'TERM',
  'VIEW',
  'WINDOW',
  'PALETTE',
  'FIELD',
  'LSET',
  'RSET',
  'WRITE',
  'LPRINT',
  'LLIST',
  'HELP',
  'SLEEP',
  'MON',
  'SWAP',
  'OFF',
  'ERROR',
  'RESUME',
  'BEEP',
]);
/** statements that touch the hardware directly: skipped with a warning */
const HARDWARE = new Set(['SOUND', 'POKE', 'OUT', 'WAIT', 'BLOAD', 'BSAVE']);

interface Line {
  /** BASIC line number (NaN when missing) */
  num: number;
  label: string;
  toks: Tok[];
}

function tokenizeLine(text: string, lineNo: number, offset: number, label: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const at = (k: number): Pos => ({ line: lineNo, column: offset + k + 1 });
  const chars = (from: number, to: number): BStr => [...text.slice(from, to)].map((ch, k) => ({ ch, line: lineNo, column: offset + from + k + 1, label }));
  const upper = text.toUpperCase();
  const keywordAt = (k: number): string | undefined => KEYWORDS.find((w) => upper.startsWith(w, k));
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === "'") {
      toks.push({ t: 'kw', v: 'REM', at: at(i) });
      toks.push({ t: 'raw', v: chars(i + 1, text.length), at: at(i + 1) });
      break;
    }
    if (c === '"') {
      const close = text.indexOf('"', i + 1);
      const end = close < 0 ? text.length : close; // an unterminated string ends at the end of the line (BASIC)
      toks.push({ t: 'str', v: chars(i + 1, end), at: at(i) });
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (/[0-9.]/.test(c) && (c !== '.' || /[0-9]/.test(text[i + 1] ?? ''))) {
      let k = i;
      while (/[0-9.]/.test(text[k] ?? '')) k++;
      if (/[eEdD]/.test(text[k] ?? '') && /[-+0-9]/.test(text[k + 1] ?? '')) {
        k += 2;
        while (/[0-9]/.test(text[k] ?? '')) k++;
      }
      toks.push({ t: 'num', v: Number(text.slice(i, k).replace(/[dD]/, 'e')), at: at(i) });
      i = k;
      if (/[%!#]/.test(text[i] ?? '')) i++;
      continue;
    }
    if (c === '&' && /[HhOoBb]/.test(text[i + 1] ?? '')) {
      const base = { H: 16, O: 8, B: 2 }[text[i + 1].toUpperCase() as 'H' | 'O' | 'B'];
      let k = i + 2;
      const digit = base === 16 ? /[0-9A-Fa-f]/ : base === 8 ? /[0-7]/ : /[01]/;
      while (digit.test(text[k] ?? '')) k++;
      toks.push({ t: 'num', v: parseInt(text.slice(i + 2, k) || '0', base), at: at(i) });
      i = k;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const kw = c === '_' ? undefined : keywordAt(i);
      if (kw) {
        toks.push({ t: 'kw', v: kw, at: at(i) });
        i += kw.length;
        if (kw === 'REM') {
          toks.push({ t: 'raw', v: chars(i, text.length), at: at(i) });
          break;
        }
        if (kw === 'DATA') {
          // up to ':' outside quotes
          let k = i;
          let q = false;
          while (k < text.length && (q || text[k] !== ':')) {
            if (text[k] === '"') q = !q;
            k++;
          }
          toks.push({ t: 'raw', v: chars(i, k), at: at(i) });
          i = k;
        }
        continue;
      }
      let k = i + 1;
      while (k < text.length && /[A-Za-z0-9]/.test(text[k]) && !keywordAt(k)) k++;
      if (/[$%!#]/.test(text[k] ?? '')) k++;
      toks.push({ t: 'id', v: text.slice(i, k).toUpperCase(), at: at(i) });
      i = k;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '<>' || two === '><' || two === '<=' || two === '=<' || two === '>=' || two === '=>') {
      toks.push({ t: 'op', v: two === '><' ? '<>' : two === '=<' ? '<=' : two === '=>' ? '>=' : two, at: at(i) });
      i += 2;
      continue;
    }
    toks.push({ t: 'op', v: c, at: at(i) });
    i++;
  }
  return toks;
}

function parseProgram(text: string): Line[] {
  const lines: Line[] = [];
  // Ctrl-Z (0x1A) marks the end of an MSX / MS-DOS ASCII file
  const eof = text.indexOf('\x1a');
  (eof >= 0 ? text.slice(0, eof) : text)
    .split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    const m = /^(\s*)(\d+)\s?/.exec(line);
    const offset = m ? m[0].length : 0;
    const label = m ? m[2] : '';
    lines.push({ num: m ? Number(m[2]) : NaN, label, toks: tokenizeLine(line.slice(offset), idx + 1, offset, label) });
  });
  return lines;
}

/* ------------------------------------------------------------------ interpreter */

const MAX_STEPS = 2_000_000;
const str = (s: string, at: Pos, label = ''): BStr => [...s].map((ch) => ({ ch, line: at.line, column: at.column, label }));
const text = (s: BStr) => s.map((c) => c.ch).join('');

interface ForFrame {
  name: string;
  end: number;
  step: number;
  line: number;
  tok: number;
}

export function runBasic(source: string, opt: BasicOptions): { title?: string } {
  const lines = parseProgram(source);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].num <= lines[i - 1].num)
      opt.warn('W_BASIC_ORDER', '行番号が昇順でない行があります。書かれている順に実行しました。', lines[i].toks[0]?.at ?? { line: 1, column: 1 });
  }
  const vars = new Map<string, Value>();
  const defStr = new Set<string>();
  const nameLen = opt.nameLength ?? 40;
  let title: string | undefined;
  let played = false;

  // DATA items in program order
  const data: Array<{ value: BStr; at: Pos; line: number }> = [];
  lines.forEach((ln, li) => {
    ln.toks.forEach((t, k) => {
      if (t.t !== 'kw' || t.v !== 'DATA') return;
      const raw = ln.toks[k + 1];
      if (raw?.t !== 'raw') return;
      let cur: BStr = [];
      let q = false;
      let quoted = false;
      for (const c of raw.v) {
        if (c.ch === '"') {
          q = !q;
          quoted = true;
          continue;
        }
        if (c.ch === ',' && !q) {
          data.push({ value: quoted ? cur : trim(cur), at: raw.at, line: li });
          cur = [];
          quoted = false;
          continue;
        }
        cur.push(c);
      }
      data.push({ value: quoted ? cur : trim(cur), at: raw.at, line: li });
    });
  });
  let dataPtr = 0;

  const key = (name: string): string => {
    const suffix = /[$%!#]$/.test(name) ? name.slice(-1) : '';
    const base = suffix ? name.slice(0, -1) : name;
    return base.slice(0, nameLen) + suffix;
  };
  const isStrName = (name: string) => name.endsWith('$') || (!/[%!#]$/.test(name) && defStr.has(name[0]));

  let li = 0;
  let ti = 0;
  let steps = 0;
  const forStack: ForFrame[] = [];
  const gosubStack: Array<{ line: number; tok: number }> = [];
  /** program state when a line was last entered by a backward jump (infinite repeat detection) */
  const seen = new Map<number, string>();
  /** incremented when a variable gets a different value */
  let version = 0;
  const setVar = (k: string, v: Value) => {
    const old = vars.get(k);
    const same = old !== undefined && (typeof old === 'number' ? old === v : typeof v !== 'number' && text(old) === text(v));
    if (!same) version++;
    vars.set(k, v);
  };
  const stateKey = () => `${dataPtr}|${forStack.map((f) => `${f.name}:${vars.get(f.name)}`).join(',')}|${gosubStack.length}|${version}`;

  const toks = () => lines[li]?.toks ?? [];
  const peek = (o = 0): Tok | undefined => toks()[ti + o];
  const here = (): Pos => peek()?.at ?? lines[li]?.toks.at(-1)?.at ?? { line: 1, column: 1 };
  const isOp = (t: Tok | undefined, v: string) => t?.t === 'op' && t.v === v;
  const isKw = (t: Tok | undefined, v: string) => t?.t === 'kw' && t.v === v;
  const endOfStatement = () => {
    const t = peek();
    return !t || isOp(t, ':') || isKw(t, 'ELSE');
  };
  const skipStatement = () => {
    while (!endOfStatement()) ti++;
  };
  const expectOp = (v: string) => {
    if (!isOp(peek(), v)) fail('E_BASIC_SYNTAX', `${v} が必要です。`, here());
    ti++;
  };

  /* ---------------- expressions */
  const num = (v: Value, at: Pos): number => (typeof v === 'number' ? v : fail('E_BASIC_TYPE', '数値が必要な所に文字列があります。', at));
  const strv = (v: Value, at: Pos): BStr => (typeof v !== 'number' ? v : fail('E_BASIC_TYPE', '文字列が必要な所に数値があります。', at));
  const truth = (b: boolean) => (b ? -1 : 0);

  const expr = (): Value => orExpr();
  const orExpr = (): Value => {
    let l = andExpr();
    while (isKw(peek(), 'OR') || isKw(peek(), 'XOR')) {
      const op = (peek() as Tok).v;
      const at = here();
      ti++;
      const r = andExpr();
      l = op === 'OR' ? num(l, at) | num(r, at) : num(l, at) ^ num(r, at);
    }
    return l;
  };
  const andExpr = (): Value => {
    let l = notExpr();
    while (isKw(peek(), 'AND')) {
      const at = here();
      ti++;
      l = num(l, at) & num(notExpr(), at);
    }
    return l;
  };
  const notExpr = (): Value => {
    if (isKw(peek(), 'NOT')) {
      const at = here();
      ti++;
      return ~num(notExpr(), at);
    }
    return relExpr();
  };
  const relExpr = (): Value => {
    const l = addExpr();
    const t = peek();
    if (t?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      ti++;
      const r = addExpr();
      const a = typeof l === 'number' ? l : text(l);
      const b = typeof r === 'number' ? r : text(r);
      if (typeof a !== typeof b) fail('E_BASIC_TYPE', '数値と文字列は比べられません。', t.at);
      switch (t.v) {
        case '=':
          return truth(a === b);
        case '<>':
          return truth(a !== b);
        case '<':
          return truth(a < b);
        case '>':
          return truth(a > b);
        case '<=':
          return truth(a <= b);
        default:
          return truth(a >= b);
      }
    }
    return l;
  };
  const addExpr = (): Value => {
    let l = modExpr();
    for (;;) {
      const t = peek();
      if (!(isOp(t, '+') || isOp(t, '-'))) return l;
      ti++;
      const r = modExpr();
      if (t!.v === '+' && typeof l !== 'number' && typeof r !== 'number') l = [...l, ...r];
      else l = t!.v === '+' ? num(l, t!.at) + num(r, t!.at) : num(l, t!.at) - num(r, t!.at);
    }
  };
  const modExpr = (): Value => {
    let l = idivExpr();
    while (isKw(peek(), 'MOD')) {
      const at = here();
      ti++;
      const r = num(idivExpr(), at);
      if (r === 0) fail('E_BASIC_DIV0', '0 で割っています。', at);
      l = Math.trunc(num(l, at)) % Math.trunc(r);
    }
    return l;
  };
  const idivExpr = (): Value => {
    let l = mulExpr();
    while (isOp(peek(), '\\') || isOp(peek(), '¥')) {
      const at = here();
      ti++;
      const r = Math.trunc(num(mulExpr(), at));
      if (r === 0) fail('E_BASIC_DIV0', '0 で割っています。', at);
      l = Math.trunc(Math.trunc(num(l, at)) / r);
    }
    return l;
  };
  const mulExpr = (): Value => {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!(isOp(t, '*') || isOp(t, '/'))) return l;
      ti++;
      const r = num(unary(), t!.at);
      if (t!.v === '/' && r === 0) fail('E_BASIC_DIV0', '0 で割っています。', t!.at);
      l = t!.v === '*' ? num(l, t!.at) * r : num(l, t!.at) / r;
    }
  };
  const unary = (): Value => {
    if (isOp(peek(), '-')) {
      const at = here();
      ti++;
      return -num(unary(), at);
    }
    if (isOp(peek(), '+')) {
      ti++;
      return unary();
    }
    return power();
  };
  const power = (): Value => {
    const l = primary();
    if (isOp(peek(), '^')) {
      const at = here();
      ti++;
      return num(l, at) ** num(unary(), at);
    }
    return l;
  };
  const args = (): Value[] => {
    expectOp('(');
    const out: Value[] = [];
    if (!isOp(peek(), ')')) {
      for (;;) {
        out.push(expr());
        if (!isOp(peek(), ',')) break;
        ti++;
      }
    }
    expectOp(')');
    return out;
  };
  const indexOf = (name: string): string => {
    if (!isOp(peek(), '(')) return key(name);
    const at = here();
    const idx = args().map((v) => Math.trunc(num(v, at)));
    return `${key(name)}(${idx.join(',')})`;
  };
  const primary = (): Value => {
    const t = peek();
    if (!t) fail('E_BASIC_SYNTAX', '式が途中で終わっています。', here());
    ti++;
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (isOp(t, '(')) {
      const v = expr();
      expectOp(')');
      return v;
    }
    if (t.t === 'id') {
      const k = indexOf(t.v);
      const v = vars.get(k);
      if (v !== undefined) return v;
      return isStrName(t.v) ? [] : 0;
    }
    if (t.t === 'kw') {
      const a = (): Value[] => args();
      switch (t.v) {
        case 'CHR$':
          return str(String.fromCharCode(num(a()[0], t.at)), t.at);
        case 'STR$': {
          const n = num(a()[0], t.at);
          return str(n >= 0 ? ` ${n}` : String(n), t.at);
        }
        case 'HEX$':
          return str(Math.trunc(num(a()[0], t.at)).toString(16).toUpperCase(), t.at);
        case 'LEFT$': {
          const [s, n] = a();
          return strv(s, t.at).slice(0, Math.max(0, num(n, t.at)));
        }
        case 'RIGHT$': {
          const [s, n] = a();
          const v = strv(s, t.at);
          return v.slice(Math.max(0, v.length - num(n, t.at)));
        }
        case 'MID$': {
          const [s, p, n] = a();
          const v = strv(s, t.at);
          const from = Math.max(0, num(p, t.at) - 1);
          return n === undefined ? v.slice(from) : v.slice(from, from + Math.max(0, num(n, t.at)));
        }
        case 'STRING$': {
          const [n, c] = a();
          const ch = typeof c === 'number' ? String.fromCharCode(c) : (text(c)[0] ?? ' ');
          const unit = typeof c === 'number' ? str(ch, t.at) : c.slice(0, 1);
          return Array.from({ length: Math.max(0, num(n, t.at)) }, () => unit)
            .flat()
            .map((x) => ({ ...x, ch }));
        }
        case 'SPACE$':
          return str(' '.repeat(Math.max(0, num(a()[0], t.at))), t.at);
        case 'LEN':
          return strv(a()[0], t.at).length;
        case 'VAL':
          return Number(text(strv(a()[0], t.at)).trim()) || 0;
        case 'ASC':
          return text(strv(a()[0], t.at)).charCodeAt(0) || 0;
        case 'INT':
          return Math.floor(num(a()[0], t.at));
        case 'FIX':
          return Math.trunc(num(a()[0], t.at));
        case 'ABS':
          return Math.abs(num(a()[0], t.at));
        case 'SGN':
          return Math.sign(num(a()[0], t.at));
        case 'PLAY':
          // PLAY(n): whether the queue is still playing. Converting does not wait: 0 (not playing).
          a();
          return 0;
        case 'INKEY$':
          opt.warn('W_BASIC_INKEY', 'INKEY$（キー入力）は、何も押されていないものとして変換しました。', t.at);
          return [];
        case 'STICK':
        case 'STRIG':
          a();
          opt.warn('W_BASIC_INKEY', `${t.v}（ジョイスティック）は、何も操作されていないものとして変換しました。`, t.at);
          return 0;
        case 'RND':
          if (isOp(peek(), '(')) a();
          return fail('E_BASIC_UNSUPPORTED', 'RND（乱数）を使う部分は、変換時に音が決まらないため変換できません。', t.at);
      }
      return fail('E_BASIC_UNSUPPORTED', `式の中の ${t.v} は変換できません。`, t.at);
    }
    return fail('E_BASIC_SYNTAX', `式に使えない記号です: ${t.v}`, t.at);
  };

  /* ---------------- control flow */
  const findLine = (n: number, at: Pos): number => {
    const idx = lines.findIndex((l) => l.num === n);
    if (idx < 0) fail('E_BASIC_LINE', `行番号 ${n} がありません。`, at);
    return idx;
  };
  /** returns false when the jump is an endless repeat (the program ends there) */
  const jump = (n: number, at: Pos): boolean => {
    const target = findLine(n, at);
    if (target <= li) {
      const state = stateKey();
      if (seen.get(target) === state) {
        if (played) opt.warn('W_BASIC_REPEAT', `GOTO ${n} による同じ演奏の繰り返し（無限ループ）は、1 回だけ演奏して終わりにしました。`, at);
        else opt.warn('W_BASIC_LOOP', `GOTO ${n} の無限ループで変換を終えました。`, at);
        return false;
      }
    }
    li = target;
    ti = 0;
    seen.set(li, stateKey());
    return true;
  };

  const assign = (name: string, at: Pos) => {
    const k = indexOf(name);
    expectOp('=');
    const v = expr();
    if (isStrName(name) && typeof v === 'number') fail('E_BASIC_TYPE', `${name} には文字列を代入してください。`, at);
    if (!isStrName(name) && typeof v !== 'number') fail('E_BASIC_TYPE', `${name} には数値を代入してください。`, at);
    setVar(k, typeof v === 'number' && name.endsWith('%') ? Math.trunc(v) : v);
  };

  const playStatement = (command: string, at: Pos) => {
    let device: number | null = null;
    if (isOp(peek(), '#')) {
      ti++;
      device = Math.trunc(num(expr(), here()));
      if (isOp(peek(), ',')) ti++;
    }
    const list: Array<BStr | null> = [];
    let expectArg = true;
    while (!endOfStatement()) {
      if (isOp(peek(), ',')) {
        if (expectArg) list.push(null);
        ti++;
        expectArg = true;
        continue;
      }
      const a = here();
      list.push(strv(expr(), a));
      expectArg = false;
    }
    played = true;
    opt.onPlay({ command, device, args: list, at, label: lines[li].label }, (name) => vars.get(key(name.toUpperCase())));
  };

  const callStatement = (at: Pos, nameTok?: Tok) => {
    const nt = nameTok ?? peek();
    if (!nameTok) ti++;
    if (!nt || (nt.t !== 'id' && nt.t !== 'kw')) fail('E_BASIC_SYNTAX', 'CALL の後に名前が必要です。', at);
    const name = nt.v.replace(/^_/, '').replace(/\$$/, '');
    const out: Array<number | { voice: number } | null> = [];
    if (isOp(peek(), '(')) {
      ti++;
      let expectArg = true;
      while (!isOp(peek(), ')')) {
        if (!peek()) fail('E_BASIC_SYNTAX', ') が必要です。', at);
        if (isOp(peek(), ',')) {
          if (expectArg) out.push(null);
          ti++;
          expectArg = true;
          continue;
        }
        if (isOp(peek(), '@')) {
          ti++;
          out.push({ voice: Math.trunc(num(expr(), here())) });
        } else {
          const v = expr();
          out.push(typeof v === 'number' ? v : null);
        }
        expectArg = false;
      }
      ti++;
    }
    skipStatement();
    if (opt.onCall) opt.onCall({ name, args: out, at, label: lines[li].label });
  };

  /** runs statements until the end of the line part (or ELSE) */
  const statement = (): 'next' | 'end' | 'jumped' => {
    const t = peek();
    if (!t) return 'next';
    const at = t.at;
    if (isOp(t, ':')) {
      ti++;
      return 'next';
    }
    if (t.t === 'id') {
      if (t.v.startsWith('_')) {
        ti++;
        callStatement(at, t);
        return 'next';
      }
      ti++;
      if (!isOp(peek(), '=') && !isOp(peek(), '(')) fail('E_BASIC_UNSUPPORTED', `${t.v} 文は変換できません（不明な命令）。`, at);
      assign(t.v, at);
      return 'next';
    }
    if (t.t !== 'kw') fail('E_BASIC_SYNTAX', `文の始まりに使えない記号です: ${t.t === 'op' ? t.v : ''}`, at);
    ti++;
    switch (t.v) {
      case 'REM':
        if (!played && title === undefined) {
          const raw = peek();
          const s = raw?.t === 'raw' ? text(raw.v).trim() : '';
          if (s && /[^\s*=\-_#/]/.test(s)) title = s;
        }
        ti = toks().length;
        return 'next';
      case 'DATA':
        ti++;
        return 'next';
      case 'LET': {
        const id = peek();
        if (id?.t !== 'id') fail('E_BASIC_SYNTAX', 'LET の後に変数名が必要です。', at);
        ti++;
        assign(id.v, at);
        return 'next';
      }
      case 'PLAY':
        playStatement('PLAY', at);
        return 'next';
      case 'CMD': {
        const sub = peek();
        if (opt.cmdPrefix && isKw(sub, 'PLAY')) {
          ti++;
          playStatement('CMD PLAY', at);
          return 'next';
        }
        skipStatement();
        return 'next';
      }
      case 'CALL':
        callStatement(at);
        return 'next';
      case 'DEFSTR': {
        while (!endOfStatement()) {
          const a = peek();
          ti++;
          if (a?.t === 'id' && isOp(peek(), '-')) {
            ti++;
            const b = peek();
            ti++;
            const from = a.v.charCodeAt(0);
            const to = (b?.t === 'id' ? b.v : a.v).charCodeAt(0);
            for (let c = from; c <= to; c++) defStr.add(String.fromCharCode(c));
          } else if (a?.t === 'id') defStr.add(a.v[0]);
        }
        return 'next';
      }
      case 'FOR': {
        const id = peek();
        if (id?.t !== 'id') fail('E_BASIC_SYNTAX', 'FOR の後に変数名が必要です。', at);
        ti++;
        expectOp('=');
        setVar(key(id.v), num(expr(), at));
        if (!isKw(peek(), 'TO')) fail('E_BASIC_SYNTAX', 'FOR には TO が必要です。', here());
        ti++;
        const end = num(expr(), at);
        let step = 1;
        if (isKw(peek(), 'STEP')) {
          ti++;
          step = num(expr(), at);
        }
        const name = key(id.v);
        while (forStack.length && forStack[forStack.length - 1].name === name) forStack.pop();
        forStack.push({ name, end, step, line: li, tok: ti });
        const v = vars.get(name) as number;
        if (step >= 0 ? v > end : v < end) {
          // skip to the matching NEXT
          forStack.pop();
          let depth = 0;
          for (;;) {
            const x = peek();
            if (!x) {
              li++;
              ti = 0;
              if (li >= lines.length) return 'end';
              continue;
            }
            ti++;
            if (isKw(x, 'FOR')) depth++;
            if (isKw(x, 'NEXT')) {
              if (depth === 0) {
                skipStatement();
                break;
              }
              depth--;
            }
          }
        }
        return 'next';
      }
      case 'NEXT': {
        const names: string[] = [];
        while (peek()?.t === 'id') {
          names.push(key((peek() as Tok).v as string));
          ti++;
          if (isOp(peek(), ',')) ti++;
        }
        for (let n = 0; n < Math.max(1, names.length); n++) {
          const want = names[n];
          while (want && forStack.length && forStack[forStack.length - 1].name !== want) forStack.pop();
          const f = forStack[forStack.length - 1];
          if (!f) fail('E_BASIC_NEXT', 'FOR の無い NEXT です。', at);
          const v = (vars.get(f.name) as number) + f.step;
          setVar(f.name, v);
          if (f.step >= 0 ? v <= f.end : v >= f.end) {
            li = f.line;
            ti = f.tok;
            return 'jumped';
          }
          forStack.pop();
        }
        return 'next';
      }
      case 'GO':
      case 'GOTO': {
        if (t.v === 'GO') {
          if (!isKw(peek(), 'TO')) fail('E_BASIC_SYNTAX', 'GO の後に TO が必要です。', at);
          ti++;
        }
        const n = num(expr(), at);
        return jump(n, at) ? 'jumped' : 'end';
      }
      case 'GOSUB': {
        const n = num(expr(), at);
        skipStatement();
        gosubStack.push({ line: li, tok: ti });
        if (gosubStack.length > 256) fail('E_BASIC_LIMIT', 'GOSUB の入れ子が深すぎます。', at);
        li = findLine(n, at);
        ti = 0;
        return 'jumped';
      }
      case 'RETURN': {
        const r = gosubStack.pop();
        if (!r) fail('E_BASIC_RETURN', 'GOSUB の無い RETURN です。', at);
        if (!endOfStatement()) {
          const n = num(expr(), at);
          li = findLine(n, at);
          ti = 0;
        } else {
          li = r.line;
          ti = r.tok;
        }
        return 'jumped';
      }
      case 'ON': {
        if (peek()?.t === 'kw') {
          skipStatement(); // ON STOP GOSUB / ON INTERVAL / ON KEY ... : event traps, not music
          return 'next';
        }
        const v = Math.trunc(num(expr(), at));
        const kind = peek();
        if (!(isKw(kind, 'GOTO') || isKw(kind, 'GOSUB'))) {
          skipStatement(); // ON STOP / ON INTERVAL ... : not music
          return 'next';
        }
        ti++;
        const targets: number[] = [];
        while (!endOfStatement()) {
          if (isOp(peek(), ',')) {
            ti++;
            continue;
          }
          targets.push(num(expr(), at));
        }
        const n = targets[v - 1];
        if (n === undefined) return 'next';
        if (isKw(kind, 'GOSUB')) {
          gosubStack.push({ line: li, tok: ti });
          li = findLine(n, at);
          ti = 0;
          return 'jumped';
        }
        return jump(n, at) ? 'jumped' : 'end';
      }
      case 'IF': {
        const cond = num(expr(), at) !== 0;
        let thenLine: number | null = null;
        if (isKw(peek(), 'THEN') || isKw(peek(), 'GOTO')) {
          const goto = isKw(peek(), 'GOTO');
          ti++;
          if (peek()?.t === 'num' || goto) thenLine = num(expr(), at);
        } else fail('E_BASIC_SYNTAX', 'IF には THEN が必要です。', here());
        if (cond) {
          if (thenLine !== null) return jump(thenLine, at) ? 'jumped' : 'end';
          return 'next'; // statements after THEN run; ELSE is skipped at the end of the part
        }
        // skip to ELSE at the same IF depth, or to the end of the line
        let depth = 0;
        while (peek()) {
          const x = peek();
          ti++;
          if (isKw(x, 'IF')) depth++;
          if (isKw(x, 'ELSE')) {
            if (depth === 0) {
              if (peek()?.t === 'num') return jump(num(expr(), at), at) ? 'jumped' : 'end';
              return 'next';
            }
            depth--;
          }
        }
        return 'next';
      }
      case 'ELSE':
        // reached after a THEN part ran: the rest of the line is the ELSE part
        ti = toks().length;
        return 'next';
      case 'READ': {
        while (!endOfStatement()) {
          if (isOp(peek(), ',')) {
            ti++;
            continue;
          }
          const id = peek();
          if (id?.t !== 'id') fail('E_BASIC_SYNTAX', 'READ の後に変数名が必要です。', at);
          ti++;
          const k = indexOf(id.v);
          const d = data[dataPtr++];
          if (!d) fail('E_BASIC_DATA', 'READ する DATA がもうありません。', at);
          if (isStrName(id.v)) setVar(k, d.value);
          else {
            const n = Number(text(d.value).trim());
            if (!Number.isFinite(n)) fail('E_BASIC_TYPE', `DATA の「${text(d.value)}」を数値として READ できません。`, d.at);
            setVar(k, n);
          }
        }
        return 'next';
      }
      case 'RESTORE': {
        if (endOfStatement()) dataPtr = 0;
        else {
          const n = num(expr(), at);
          const target = findLine(n, at);
          dataPtr = data.findIndex((d) => d.line >= target);
          if (dataPtr < 0) dataPtr = data.length;
        }
        return 'next';
      }
      case 'STOP':
        if (isKw(peek(), 'ON') || isKw(peek(), 'OFF') || isKw(peek(), 'STOP')) {
          skipStatement(); // STOP ON / STOP OFF: event trap switch
          return 'next';
        }
        return 'end';
      case 'END':
        return 'end';
      case 'INPUT':
        return fail('E_BASIC_UNSUPPORTED', 'INPUT（キーボード入力）を使うプログラムは変換できません。', at);
    }
    if (HARDWARE.has(t.v)) {
      opt.warn('W_BASIC_HARDWARE', `${t.v}（音源や I/O への直接の書き込み）は変換しません。`, at);
      skipStatement();
      return 'next';
    }
    if (IGNORED.has(t.v)) {
      skipStatement();
      return 'next';
    }
    return fail('E_BASIC_UNSUPPORTED', `${t.v} 文は変換できません。`, at);
  };

  if (lines.length) seen.set(0, stateKey());
  outer: while (li < lines.length) {
    while (ti < toks().length) {
      if (++steps > MAX_STEPS) {
        if (!opt.bestEffort) fail('E_BASIC_LIMIT', 'プログラムの実行が長すぎるため変換を中止しました（無限ループの可能性があります）。', here());
        opt.warn('W_BASIC_APPROX', 'プログラムの実行が長すぎるため、ここまでに演奏した分で変換を終えました（近似変換）。', here());
        break outer;
      }
      const before = { li, ti };
      let r: 'next' | 'end' | 'jumped';
      try {
        r = statement();
      } catch (e) {
        if (!(e instanceof BasicError) || !opt.bestEffort || e.code === 'E_BASIC_LIMIT') throw e;
        opt.warn('W_BASIC_APPROX', `${e.message}（近似変換: この文をスキップしました）`, e.at);
        li = before.li;
        ti = Math.max(ti, before.ti + 1);
        if (li === before.li) skipStatement();
        r = 'next';
      }
      if (r === 'end') break outer;
      if (r === 'jumped') continue outer;
      if (isKw(peek(), 'ELSE')) ti = toks().length; // the THEN part ended
    }
    li++;
    ti = 0;
    if (li < lines.length) seen.set(li, stateKey());
  }
  return { title };
}

function trim(s: BStr): BStr {
  let a = 0;
  let b = s.length;
  while (a < b && /\s/.test(s[a].ch)) a++;
  while (b > a && /\s/.test(s[b - 1].ch)) b--;
  return s.slice(a, b);
}
