// MML Studio parser: tokens -> command tree (AST). Pure, no DOM.
import { error, mergeSpans } from './source';
import type { Keyword, Token } from './tokenizer';
import type { Diagnostic, SourceSpan } from './types';

export type LengthSpec =
  | { kind: 'div'; denom: number; dotted: boolean; span: SourceSpan }
  | { kind: 'ticks'; ticks: number; span: SourceSpan };

export type PitchSpec =
  | { kind: 'name'; letter: string; accidental: -1 | 0 | 1; span: SourceSpan }
  | { kind: 'abs'; pitch: number; span: SourceSpan };

export interface TieSegment {
  pitch: PitchSpec;
  length?: LengthSpec;
  adds: LengthSpec[];
  span: SourceSpan;
}

export type ChordItem = { kind: 'pitch'; pitch: PitchSpec } | { kind: 'shift'; delta: 1 | -1; span: SourceSpan };

export type Command =
  | { kind: 'track'; n: number; span: SourceSpan }
  | { kind: 'channel'; n: number; span: SourceSpan }
  | { kind: 'tempo'; bpm: number; span: SourceSpan }
  | { kind: 'tempoUs'; us: number; span: SourceSpan }
  | { kind: 'octave'; n: number; span: SourceSpan }
  | { kind: 'octaveShift'; delta: 1 | -1; span: SourceSpan }
  | { kind: 'defaultLength'; length: LengthSpec; span: SourceSpan }
  | { kind: 'velocity'; n: number; span: SourceSpan }
  | { kind: 'gate'; mode: 'percent' | 'ticks'; value: number; span: SourceSpan }
  | { kind: 'program'; n: number; span: SourceSpan }
  | {
      kind: 'note';
      pitch: PitchSpec;
      length?: LengthSpec;
      adds: LengthSpec[];
      ties: TieSegment[];
      span: SourceSpan;
    }
  | { kind: 'chord'; items: ChordItem[]; length?: LengthSpec; span: SourceSpan }
  | { kind: 'rest'; length?: LengthSpec; span: SourceSpan }
  | { kind: 'sub'; body: Command[]; span: SourceSpan }
  | { kind: 'time'; measure: number; beat: number; tick: number; span: SourceSpan }
  | { kind: 'cc'; controller: number; value: number; span: SourceSpan }
  | { kind: 'pitchbend'; value: number; span: SourceSpan };

export interface ParseResult {
  commands: Command[];
  diagnostics: Diagnostic[];
}

const NOTE_LETTERS = 'cdefgab';
const VALID_DENOMS = new Set([1, 2, 4, 8, 16, 32, 64]);
export const MAX_TICK_LENGTH = 2_000_000;
export const MAX_SUB_DEPTH = 8;
const FORBIDDEN_IN_SUB = new Set<Command['kind']>(['track', 'channel', 'tempo', 'tempoUs', 'time']);

type NumberToken = Token & { type: 'number' };
type LetterToken = Token & { type: 'letter' };

class Parser {
  private pos = 0;
  private target: Command[] = [];
  private subDepth = 0;
  readonly commands: Command[] = this.target;
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.pos++;
    return t;
  }
  private err(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(error(code, message, span));
  }
  private push(c: Command): void {
    this.target.push(c);
  }
  private isSymbol(t: Token, value: string): boolean {
    return t.type === 'symbol' && t.value === value;
  }
  /** Next token, if it is directly attached (no whitespace) to the previous one. */
  private attached(): Token | null {
    const t = this.peek();
    return t.type !== 'eof' && !t.spaceBefore ? t : null;
  }

  parse(): void {
    while (this.peek().type !== 'eof') this.step();
  }

  private step(): void {
    const before = this.pos;
    this.command();
    if (this.pos === before) this.next(); // guarantee progress
  }

  private command(): void {
    const t = this.peek();
    switch (t.type) {
      case 'keyword':
        return this.keyword();
      case 'letter':
        return this.letterCommand();
      case 'number':
        this.next();
        return this.err('E_UNEXPECTED_NUMBER', `予期しない数値 "${t.text}" です。音長や値は直前のコマンドに空白を入れずに続けて書いてください。`, t.span);
      case 'symbol':
        return this.symbolCommand();
      case 'eof':
        return;
    }
  }

  private symbolCommand(): void {
    const t = this.next();
    if (t.type !== 'symbol') return;
    switch (t.value) {
      case '>':
        this.push({ kind: 'octaveShift', delta: 1, span: t.span });
        return;
      case '<':
        this.push({ kind: 'octaveShift', delta: -1, span: t.span });
        return;
      case '@': {
        const n = this.attachedInteger('@', t.span);
        if (n === null) return;
        if (n.value < 1 || n.value > 128) return this.err('E_RANGE', `音色番号 @${n.text} は範囲外です（1〜128）。`, mergeSpans(t.span, n.span));
        this.push({ kind: 'program', n: n.value, span: mergeSpans(t.span, n.span) });
        return;
      }
      case "'":
        return this.chord(t.span);
      case '[':
      case ']':
        return this.err('E_UNSUPPORTED', '[ ] によるループは MML Studio では未対応です。', t.span);
      case '{':
        return this.err('E_UNSUPPORTED', '{ } による連符は MML Studio では未対応です（声部の重ねは Sub{...} を使います）。', t.span);
      case '}':
        return this.err('E_SYNTAX', '対応する Sub{ がない } です。', t.span);
      case '&':
        return this.err('E_TIE', '& は同じ音高の音符同士をつなぐ場合にのみ使えます（例: c4&c4）。', t.span);
      case '^':
        return this.err('E_TIE', '^ は音符の直後にのみ使えます（例: c4^8）。', t.span);
      case '%': {
        const num = this.attached();
        if (num?.type === 'number') this.next();
        return this.err('E_SYNTAX', '% は音符・休符・l・q の直後にのみ書けます（例: c%240, q%200）。', t.span);
      }
      default:
        return this.err('E_UNEXPECTED', `予期しない記号 "${t.value}" です。`, t.span);
    }
  }

  private letterCommand(): void {
    const t = this.next();
    if (t.type !== 'letter') return;
    const c = t.value;
    if (NOTE_LETTERS.includes(c)) return this.note(t);
    switch (c) {
      case 'r': {
        const length = this.optionalLength();
        if (length === null) return;
        const span = length ? mergeSpans(t.span, length.span) : t.span;
        this.push({ kind: 'rest', length, span });
        return;
      }
      case 'n': {
        const pitch = this.absolutePitch(t);
        if (!pitch) return;
        const length = this.optionalLength(false);
        if (length === null) return;
        const span = length ? mergeSpans(pitch.span, length.span) : pitch.span;
        this.push({ kind: 'note', pitch, length, adds: [], ties: [], span });
        return;
      }
      case 'o': {
        const n = this.attachedInteger('o', t.span);
        if (n === null) return;
        const span = mergeSpans(t.span, n.span);
        if (n.value > 9) return this.err('E_RANGE', `オクターブ o${n.text} は範囲外です（0〜9）。`, span);
        this.push({ kind: 'octave', n: n.value, span });
        return;
      }
      case 'l': {
        const length = this.optionalLength();
        if (length === null) return;
        if (!length) return this.err('E_MISSING_VALUE', 'l の後に音長（1,2,4,8,16,32,64 または %N）が必要です（例: l8, l%240）。', t.span);
        this.push({ kind: 'defaultLength', length, span: mergeSpans(t.span, length.span) });
        return;
      }
      case 't': {
        const n = this.attachedInteger('t', t.span);
        if (n === null) return;
        const span = mergeSpans(t.span, n.span);
        if (n.value < 20 || n.value > 300) return this.err('E_RANGE', `テンポ t${n.text} は範囲外です（20〜300）。`, span);
        this.push({ kind: 'tempo', bpm: n.value, span });
        return;
      }
      case 'v': {
        const n = this.attachedInteger('v', t.span);
        if (n === null) return;
        const span = mergeSpans(t.span, n.span);
        if (n.value > 127) return this.err('E_RANGE', `ベロシティ v${n.text} は範囲外です（0〜127）。`, span);
        this.push({ kind: 'velocity', n: n.value, span });
        return;
      }
      case 'q': {
        const a = this.attached();
        if (a && this.isSymbol(a, '%')) {
          this.next();
          const n = this.attachedInteger('q%', mergeSpans(t.span, a.span));
          if (n === null) return;
          const span = mergeSpans(t.span, n.span);
          if (n.value > MAX_TICK_LENGTH) return this.err('E_RANGE', `ゲート q%${n.text} は範囲外です（0〜${MAX_TICK_LENGTH}）。`, span);
          this.push({ kind: 'gate', mode: 'ticks', value: n.value, span });
          return;
        }
        const n = this.attachedInteger('q', t.span);
        if (n === null) return;
        const span = mergeSpans(t.span, n.span);
        if (n.value > 100) return this.err('E_RANGE', `ゲート率 q${n.text} は範囲外です（0〜100）。`, span);
        this.push({ kind: 'gate', mode: 'percent', value: n.value, span });
        return;
      }
      default:
        this.err('E_UNKNOWN_COMMAND', `不明なコマンド "${t.text}" です。`, t.span);
    }
  }

  private absolutePitch(t: LetterToken): PitchSpec | null {
    const n = this.attachedInteger('n', t.span);
    if (n === null) return null;
    const span = mergeSpans(t.span, n.span);
    if (n.value > 127) {
      this.err('E_RANGE', `ノート番号 n${n.text} は範囲外です（0〜127）。`, span);
      return null;
    }
    return { kind: 'abs', pitch: n.value, span };
  }

  private note(letterTok: LetterToken): void {
    const head = this.noteHead(letterTok);
    const segments: TieSegment[] = [head];
    while (this.isSymbol(this.peek(), '&')) {
      const amp = this.next();
      const t = this.peek();
      if (t.type === 'letter' && NOTE_LETTERS.includes(t.value)) {
        this.next();
        segments.push(this.noteHead(t as LetterToken));
        continue;
      }
      if (t.type === 'letter' && t.value === 'r') {
        this.err('E_TIE', '& で休符をつなぐことはできません。', mergeSpans(amp.span, t.span));
      } else if (t.type === 'keyword' && (t.value === 'tr' || t.value === 'track')) {
        this.err('E_TIE', '& でトラック切替をまたぐことはできません。', mergeSpans(amp.span, t.span));
      } else {
        this.err('E_TIE', '& の後には同じ音高の音符が必要です（例: c4&c4）。', amp.span);
      }
      return;
    }
    const [first, ...ties] = segments;
    const span = mergeSpans(first.span, segments[segments.length - 1].span);
    this.push({ kind: 'note', pitch: first.pitch, length: first.length, adds: first.adds, ties, span });
  }

  private pitchName(letterTok: LetterToken): PitchSpec {
    let accidental: -1 | 0 | 1 = 0;
    let pitchSpan = letterTok.span;
    const a = this.attached();
    if (a && a.type === 'symbol' && (a.value === '+' || a.value === '#' || a.value === '-')) {
      this.next();
      accidental = a.value === '-' ? -1 : 1;
      pitchSpan = mergeSpans(pitchSpan, a.span);
      const b = this.attached();
      if (b && b.type === 'symbol' && (b.value === '+' || b.value === '#' || b.value === '-')) {
        this.next();
        this.err('E_ACCIDENTAL', '臨時記号（+ # -）は1個までです。', b.span);
      }
    }
    return { kind: 'name', letter: letterTok.value, accidental, span: pitchSpan };
  }

  private noteHead(letterTok: LetterToken): TieSegment {
    const pitch = this.pitchName(letterTok);
    const length = this.optionalLength() ?? undefined;
    let span = length ? mergeSpans(pitch.span, length.span) : pitch.span;
    const adds: LengthSpec[] = [];
    while (this.isSymbol(this.peek(), '^')) {
      const caret = this.next();
      const add = this.optionalLength();
      if (add === null) break;
      if (!add) {
        this.err('E_TIE', '^ の後に音長が必要です（例: c4^8）。', caret.span);
        break;
      }
      if (add.kind === 'ticks') {
        this.err('E_LENGTH_MIX', '^ の後には分母式の音長（1,2,4,8,16,32,64）を書きます。% 指定は使えません。', add.span);
        break;
      }
      adds.push(add);
      span = mergeSpans(span, add.span);
    }
    return { pitch, length, adds, span };
  }

  /**
   * Attached `N`, `N.` or `%N` length. undefined: no length follows; null: invalid (already reported).
   * `allowDiv=false` is used after `nN`, where a denominator would be ambiguous (D-007).
   */
  private optionalLength(allowDiv = true): LengthSpec | undefined | null {
    const a = this.attached();
    if (!a) return undefined;
    if (this.isSymbol(a, '%')) {
      this.next();
      const num = this.attached();
      if (!num || num.type !== 'number') {
        this.err('E_MISSING_VALUE', '% の後に tick 数が必要です（例: c%240）。', a.span);
        return null;
      }
      this.next();
      const span = mergeSpans(a.span, num.span);
      if (num.value < 1 || num.value > MAX_TICK_LENGTH) {
        this.err('E_RANGE', `tick 音長 %${num.text} は範囲外です（1〜${MAX_TICK_LENGTH}）。`, span);
        return null;
      }
      const after = this.attached();
      if (after && (this.isSymbol(after, '.') || after.type === 'number')) {
        this.next();
        this.err('E_LENGTH_MIX', '% による tick 音長に付点や分母式は併用できません。', after.span);
        return null;
      }
      return { kind: 'ticks', ticks: num.value, span };
    }
    if (a.type !== 'number' || !allowDiv) return undefined;
    this.next();
    let span = a.span;
    let dotted = false;
    const d = this.attached();
    if (d && this.isSymbol(d, '.')) {
      this.next();
      dotted = true;
      span = mergeSpans(span, d.span);
      const d2 = this.attached();
      if (d2 && this.isSymbol(d2, '.')) {
        this.next();
        this.err('E_DOT', '付点は1個までです。', d2.span);
      }
    }
    if (!VALID_DENOMS.has(a.value)) {
      this.err('E_RANGE', `音長 ${a.text} は使用できません（1,2,4,8,16,32,64 のいずれか）。`, a.span);
      return null;
    }
    const pct = this.attached();
    if (pct && this.isSymbol(pct, '%')) {
      this.next();
      const num = this.attached();
      if (num?.type === 'number') this.next();
      this.err('E_LENGTH_MIX', '分母式の音長と % による tick 音長は併用できません。', pct.span);
      return null;
    }
    return { kind: 'div', denom: a.value, dotted, span };
  }

  private attachedInteger(cmd: string, cmdSpan: SourceSpan): NumberToken | null {
    const a = this.attached();
    if (a && a.type === 'number') {
      this.next();
      return a;
    }
    this.err('E_MISSING_VALUE', `${cmd} の後に数値が必要です。`, cmdSpan);
    return null;
  }

  /** Chord `'...'[length]` (SPEC 3.7). The opening quote has been consumed. */
  private chord(openSpan: SourceSpan): void {
    const items: ChordItem[] = [];
    let span = openSpan;
    let failed = false;
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        this.err('E_SYNTAX', "和音の閉じ引用符 ' がありません。", span);
        return;
      }
      this.next();
      span = mergeSpans(span, t.span);
      if (this.isSymbol(t, "'")) break;
      if (t.type === 'letter' && NOTE_LETTERS.includes(t.value)) {
        items.push({ kind: 'pitch', pitch: this.pitchName(t) });
        const len = this.attached();
        if (len && (len.type === 'number' || this.isSymbol(len, '%') || this.isSymbol(len, '.'))) {
          this.err('E_CHORD', '和音の構成音には個別の音長を付けられません。音長は閉じ引用符の後に書きます（例: \'ceg\'4）。', len.span);
          failed = true;
          this.next();
        }
        continue;
      }
      if (t.type === 'letter' && t.value === 'n') {
        const p = this.absolutePitch(t);
        if (p) items.push({ kind: 'pitch', pitch: p });
        else failed = true;
        continue;
      }
      if (this.isSymbol(t, '>') || this.isSymbol(t, '<')) {
        items.push({ kind: 'shift', delta: t.type === 'symbol' && t.value === '>' ? 1 : -1, span: t.span });
        continue;
      }
      this.err('E_CHORD', '和音の中に書けるのは音名（臨時記号付き可）、nN、< > だけです。', t.span);
      failed = true;
      const arg = this.attached();
      if (arg?.type === 'number') this.next();
    }
    const length = this.optionalLength();
    if (length === null) return;
    if (length) span = mergeSpans(span, length.span);
    if (failed) return;
    const count = items.filter((i) => i.kind === 'pitch').length;
    if (count < 2) {
      this.err('E_CHORD', '和音には2音以上が必要です。', span);
      return;
    }
    this.push({ kind: 'chord', items, length, span });
  }

  /** `(` args `)` with the given separator. Returns null after reporting an error. */
  private args(label: string, kwSpan: SourceSpan, arity: number, separator: string, allowNegative = false): { values: number[]; texts: string[]; span: SourceSpan } | null {
    const open = this.peek();
    if (!this.isSymbol(open, '(')) {
      this.err('E_SYNTAX', `${label} の後に ( が必要です。`, kwSpan);
      return null;
    }
    this.next();
    const values: number[] = [];
    const texts: string[] = [];
    let span = mergeSpans(kwSpan, open.span);
    for (let i = 0; i < arity; i++) {
      if (i > 0) {
        const sep = this.peek();
        if (!this.isSymbol(sep, separator)) {
          this.recoverTo(')');
          this.err(sep.type === 'symbol' && sep.value === ')' ? 'E_MISSING_VALUE' : 'E_SYNTAX', `${label} には「${separator}」区切りで ${arity} 個の整数が必要です。`, mergeSpans(span, sep.span));
          return null;
        }
        this.next();
      }
      let sign = 1;
      let text = '';
      if (allowNegative && this.isSymbol(this.peek(), '-')) {
        this.next();
        sign = -1;
        text = '-';
      }
      const n = this.peek();
      if (n.type !== 'number') {
        const closed = this.isSymbol(n, ')');
        this.recoverTo(')');
        this.err(closed ? 'E_MISSING_VALUE' : 'E_SYNTAX', `${label} には整数の引数が必要です（例: ${example(label)}）。`, mergeSpans(span, n.span));
        return null;
      }
      this.next();
      values.push(sign * n.value);
      texts.push(text + n.text);
      span = mergeSpans(span, n.span);
    }
    const close = this.peek();
    if (!this.isSymbol(close, ')')) {
      this.err('E_SYNTAX', `${label}( の閉じ括弧 ) がありません。`, mergeSpans(span, close.span));
      return null;
    }
    this.next();
    return { values, texts, span: mergeSpans(span, close.span) };
  }

  /** Error recovery: skip a few tokens up to (and including) `close`, stopping early at the next command. */
  private recoverTo(close: string): void {
    for (let i = 0; i < 8; i++) {
      const t = this.peek();
      if (t.type === 'eof') return;
      if (this.isSymbol(t, close)) {
        this.next();
        return;
      }
      if (t.type === 'keyword' || (t.type === 'letter' && t.spaceBefore)) return;
      this.next();
    }
  }

  private keyword(): void {
    const t = this.next();
    if (t.type !== 'keyword') return;
    const label = t.text;
    switch (t.value) {
      case 'tr':
      case 'track':
      case 'ch':
      case 'channel': {
        let value: number;
        let text: string;
        let span: SourceSpan;
        if (this.isSymbol(this.peek(), '=')) {
          const eq = this.next();
          const n = this.peek();
          if (n.type !== 'number') return this.err('E_MISSING_VALUE', `${label}= の後に整数が必要です。`, mergeSpans(t.span, eq.span));
          this.next();
          value = n.value;
          text = n.text;
          span = mergeSpans(t.span, n.span);
        } else {
          const a = this.args(label, t.span, 1, ',');
          if (!a) return;
          value = a.values[0];
          text = a.texts[0];
          span = a.span;
        }
        if (t.value === 'tr' || t.value === 'track') {
          if (value > 32) return this.err('E_RANGE', `トラック番号 ${text} は範囲外です（0〜32）。`, span);
          this.push({ kind: 'track', n: value, span });
        } else {
          if (value < 1 || value > 16) return this.err('E_RANGE', `チャンネル ${text} は範囲外です（1〜16）。`, span);
          this.push({ kind: 'channel', n: value, span });
        }
        return;
      }
      case 'tempo': {
        const a = this.args(label, t.span, 1, ',');
        if (!a) return;
        if (a.values[0] < 20 || a.values[0] > 300) return this.err('E_RANGE', `テンポ ${a.texts[0]} は範囲外です（20〜300）。`, a.span);
        this.push({ kind: 'tempo', bpm: a.values[0], span: a.span });
        return;
      }
      case 'tempous': {
        const a = this.args(label, t.span, 1, ',');
        if (!a) return;
        if (a.values[0] < 1 || a.values[0] > 0xffffff) return this.err('E_RANGE', `TempoUS(${a.texts[0]}) は範囲外です（1〜16777215 μs/4分音符）。`, a.span);
        this.push({ kind: 'tempoUs', us: a.values[0], span: a.span });
        return;
      }
      case 'time': {
        const a = this.args(label, t.span, 3, ':');
        if (!a) return;
        const [m, b, s] = a.values;
        if (m < 1) return this.err('E_RANGE', `Time の小節 ${a.texts[0]} は範囲外です（1以上）。`, a.span);
        if (b < 1 || b > 4) return this.err('E_RANGE', `Time の拍 ${a.texts[1]} は範囲外です（1〜4、4/4 固定座標）。`, a.span);
        if (s > 479) return this.err('E_RANGE', `Time の tick ${a.texts[2]} は範囲外です（0〜479）。`, a.span);
        this.push({ kind: 'time', measure: m, beat: b, tick: s, span: a.span });
        return;
      }
      case 'cc': {
        const a = this.args(label, t.span, 2, ',');
        if (!a) return;
        const [c, v] = a.values;
        if (c > 127) return this.err('E_RANGE', `CC のコントローラ番号 ${a.texts[0]} は範囲外です（0〜127）。`, a.span);
        if (v > 127) return this.err('E_RANGE', `CC の値 ${a.texts[1]} は範囲外です（0〜127）。`, a.span);
        this.push({ kind: 'cc', controller: c, value: v, span: a.span });
        return;
      }
      case 'pb': {
        const a = this.args(label, t.span, 1, ',', true);
        if (!a) return;
        const v = a.values[0];
        if (v < -8192 || v > 8191) return this.err('E_RANGE', `PB(${a.texts[0]}) は範囲外です（-8192〜8191）。`, a.span);
        this.push({ kind: 'pitchbend', value: v, span: a.span });
        return;
      }
      case 'sub':
        return this.sub(t.span);
    }
  }

  private sub(kwSpan: SourceSpan): void {
    const open = this.next(); // tokenizer guarantees `{` follows
    let span = mergeSpans(kwSpan, open.span);
    const body: Command[] = [];
    const outer = this.target;
    this.target = body;
    this.subDepth++;
    const tooDeep = this.subDepth > MAX_SUB_DEPTH;
    let closed = false;
    try {
      while (this.peek().type !== 'eof') {
        const t = this.peek();
        if (this.isSymbol(t, '}')) {
          this.next();
          span = mergeSpans(span, t.span);
          closed = true;
          break;
        }
        this.step();
      }
    } finally {
      this.subDepth--;
      this.target = outer;
    }
    if (!closed) return this.err('E_SYNTAX', 'Sub{ の閉じ括弧 } がありません。', span);
    if (tooDeep) return this.err('E_SUB_DEPTH', `Sub{} の入れ子は ${MAX_SUB_DEPTH} 階層までです。`, mergeSpans(kwSpan, open.span));
    for (const c of body) {
      if (FORBIDDEN_IN_SUB.has(c.kind)) {
        this.err('E_SUB_FORBIDDEN', 'Sub{} の中では TR / CH / Tempo / TempoUS / t / Time は使えません。', c.span);
      }
    }
    this.push({ kind: 'sub', body, span });
  }
}

function example(label: string): string {
  switch (label.toLowerCase()) {
    case 'time':
      return 'Time(2:1:0)';
    case 'cc':
      return 'CC(64,127)';
    case 'pb':
      return 'PB(-1024)';
    case 'tempous':
      return 'TempoUS(500000)';
    default:
      return `${label}(1)`;
  }
}

export function parse(tokens: Token[]): ParseResult {
  const p = new Parser(tokens);
  p.parse();
  return { commands: p.commands, diagnostics: p.diagnostics };
}

export type { Keyword };
