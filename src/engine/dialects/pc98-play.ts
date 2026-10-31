// PC-9801 PLAY statement (line-numbered format) -> MML Studio MML (SPEC 4.5.3 - 4.5.5).
// Hand-written. The MML Studio language itself is not extended: the output is plain SPEC 3 syntax.
import { compileMml } from '../compiler';
import { PPQ, type NoteEvent } from '../types';
import { FM_VOICES, SSG_DEFAULT_GM } from './fm-voices';
import type { DialectConvertResult, DialectSong, DialectWarning } from './types';

const WHOLE = PPQ * 4;
const MAX_PARTS = 6;
const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
const LENGTH_TOKENS: Array<[number, string]> = [
  [1920, '1'],
  [1440, '2.'],
  [960, '2'],
  [720, '4.'],
  [480, '4'],
  [360, '8.'],
  [240, '8'],
  [180, '16.'],
  [120, '16'],
  [90, '32.'],
  [60, '32'],
  [45, '64.'],
  [30, '64'],
];

/* ------------------------------------------------------------------ input lines */

interface Segment {
  /** 1-based source line */
  line: number;
  /** 1-based column of the first character inside the quotes */
  column: number;
  text: string;
  lineLabel: string;
}

interface ParsedSong {
  title?: string;
  startLine: number;
  /** parts[i] = segments of part i in line order */
  parts: Segment[][];
}

class DialectError extends Error {
  constructor(readonly issue: DialectWarning) {
    super(issue.message);
  }
}

function err(code: string, message: string, line: number, column: number): never {
  throw new DialectError({ code, message, line, column });
}

const HEADER = /^\s*"([^"]*)"\s*,\s*"([^"]*)"\s*(?:,\s*-?\d+\s*)*$/;
const DATA = /^(\s*)(\d+)(\s+)(?:(PLAY)(\s*))?/i;

/** Splits `"a","b",...` starting at `start`; returns strings with their 1-based columns. */
function quotedList(text: string, start: number, lineNo: number): Array<{ value: string; column: number }> {
  const out: Array<{ value: string; column: number }> = [];
  let i = start;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] !== '"') err('E_DIALECT_LINE', `引用符 " で囲んだ演奏データが必要です。`, lineNo, i + 1);
    const close = text.indexOf('"', i + 1);
    if (close < 0) err('E_DIALECT_QUOTE', '引用符 " が閉じていません。', lineNo, i + 1);
    out.push({ value: text.slice(i + 1, close), column: i + 2 });
    i = close + 1;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i >= text.length || text[i] === '\r') return out;
    if (text[i] !== ',') err('E_DIALECT_LINE', 'パートの区切りはカンマ , です。', lineNo, i + 1);
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
    if (!d) err('E_DIALECT_LINE', '「行番号 "パート1","パート2",…」の形式ではない行です（BASIC のプログラム文は変換できません）。', lineNo, 1);
    const after = d[0].length;
    if (line[after] !== '"') {
      err('E_DIALECT_LINE', '行番号の後には引用符付きの演奏データが必要です（GOTO などの BASIC 文は変換できません）。', lineNo, after + 1);
    }
    const values = quotedList(line, after, lineNo);
    if (values.length > MAX_PARTS) err('E_DIALECT_PARTS', `パートは ${MAX_PARTS} 個までです（${values.length} 個あります）。`, lineNo, values[MAX_PARTS].column - 1);
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

/* ------------------------------------------------------------------ MML interpretation */

interface Char {
  ch: string;
  line: number;
  column: number;
  lineLabel: string;
}

type PartEvent =
  | { kind: 'note'; pitch: number; start: number; duration: number; gate: number; velocity: number; qPct: number; lengthText?: string; line: string; at: Char; tiedToDifferent?: boolean }
  | { kind: 'rest'; start: number; duration: number; line: string }
  | { kind: 'program'; tick: number; fm: number; line: string }
  | { kind: 'tempo'; tick: number; bpm: number; at: Char }
  | { kind: 'defaultLength'; ticks: number; line: string };

interface PartResult {
  events: PartEvent[];
  endTick: number;
}

class Warnings {
  private readonly map = new Map<string, DialectWarning>();
  add(code: string, message: string, at: { line: number; column: number }): void {
    const key = `${code}\u0000${message}`;
    const w = this.map.get(key);
    if (w) w.count = (w.count ?? 1) + 1;
    else this.map.set(key, { code, message, line: at.line, column: at.column, count: 1 });
  }
  list(): DialectWarning[] {
    return [...this.map.values()].sort((a, b) => a.line - b.line || a.column - b.column);
  }
}

function gateOf(duration: number, qPct: number): number {
  let gate = Math.round((duration * qPct) / 100);
  if (qPct > 0 && gate < 1) gate = 1;
  return gate;
}

function interpretPart(segments: Segment[], warn: Warnings): PartResult {
  const chars: Char[] = [];
  for (const s of segments) {
    for (let k = 0; k < s.text.length; k++) {
      const c = s.text[k];
      if (c === ' ' || c === '\t') continue; // spaces are ignored (SPEC 4.5.3)
      chars.push({ ch: c.toUpperCase(), line: s.line, column: s.column + k, lineLabel: s.lineLabel });
    }
  }
  let p = 0;
  const peek = () => chars[p]?.ch ?? '';
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const number = (): number | null => {
    if (!isDigit(peek())) return null;
    let v = 0;
    while (isDigit(peek())) v = v * 10 + Number(chars[p++].ch);
    return v;
  };

  let octave = 4;
  let defaultLength: number = PPQ;
  let velocity = Math.round((8 * 127) / 15);
  let qPct = 100;
  let tick = 0;
  const events: PartEvent[] = [];
  // `as` keeps the declared union type (they are reassigned inside the helper closures).
  let lastNote = null as Extract<PartEvent, { kind: 'note' }> | null;
  let lastRest = null as Extract<PartEvent, { kind: 'rest' }> | null;
  let tiePending = null as Char | null;

  const range = (v: number | null, lo: number, hi: number, at: Char, what: string): number => {
    if (v === null) err('E_DIALECT_VALUE', `${what} の後に数値が必要です。`, at.line, at.column);
    if (v < lo || v > hi) err('E_DIALECT_RANGE', `${what}${v} は範囲外です（${lo}〜${hi}）。`, at.line, at.column);
    return v;
  };
  /** `x` (1..64) followed by dots; null when no number follows. */
  const lengthAfter = (at: Char, base: number | null): number | null => {
    const n = number();
    let ticks: number;
    if (n === null) {
      if (base === null) return null;
      ticks = base;
    } else {
      range(n, 1, 64, at, '音長 ');
      const exact = WHOLE / n;
      ticks = Math.round(exact);
      if (ticks !== exact) warn.add('W_DIALECT_ROUND', `音長 ${n} は 480 PPQ で割り切れないため ${ticks} tick に丸めました。`, at);
    }
    let add = ticks / 2;
    let dots = 0;
    while (peek() === '.') {
      p++;
      dots++;
      ticks += add;
      add /= 2;
    }
    if (dots >= 2) warn.add('W_DIALECT_DOTS', '付点 2 個以上は「直前の加算分の半分を足す」として変換しました（推定）。', at);
    if (!Number.isInteger(ticks)) {
      const r = Math.round(ticks);
      warn.add('W_DIALECT_ROUND', `付点の音長を ${r} tick に丸めました。`, at);
      ticks = r;
    }
    return ticks;
  };
  const pitchOf = (letter: string, at: Char, oct = octave): number => {
    let pitch = 12 * (oct + 1) + SEMITONES[letter];
    while (peek() === '+' || peek() === '#' || peek() === '-') pitch += chars[p++].ch === '-' ? -1 : 1;
    if (pitch < 0 || pitch > 127) err('E_DIALECT_RANGE', `音高が MIDI の範囲を超えています（${pitch}）。`, at.line, at.column);
    return pitch;
  };
  const addNote = (pitch: number, duration: number, at: Char) => {
    // `&` tie: same pitch extends the previous note; a different pitch is played legato.
    if (tiePending && lastNote) {
      if (lastNote.pitch === pitch && lastNote.start + lastNote.duration === tick) {
        lastNote.duration += duration;
        lastNote.gate = gateOf(lastNote.duration, lastNote.qPct);
        tick += duration;
        tiePending = null;
        return;
      }
      lastNote.gate = lastNote.duration;
      lastNote.tiedToDifferent = true;
      warn.add('W_DIALECT_SLUR', '異なる音高の & は、前の音を次の音まで隙間なく鳴らす形で変換しました。', tiePending);
    }
    tiePending = null;
    const note: Extract<PartEvent, { kind: 'note' }> = { kind: 'note', pitch, start: tick, duration, gate: gateOf(duration, qPct), velocity, qPct, line: at.lineLabel, at };
    events.push(note);
    lastNote = note;
    lastRest = null;
    tick += duration;
  };
  const addRest = (duration: number, at: Char) => {
    tiePending = null;
    const r: Extract<PartEvent, { kind: 'rest' }> = { kind: 'rest', start: tick, duration, line: at.lineLabel };
    events.push(r);
    lastRest = r;
    lastNote = null;
    tick += duration;
  };
  const skipArgs = () => {
    // digits and commas (e.g. Z0,3 / Y1,2)
    while (isDigit(peek()) || peek() === ',') p++;
  };

  while (p < chars.length) {
    const at = chars[p++];
    const c = at.ch;
    if (c in SEMITONES) {
      const pitch = pitchOf(c, at);
      addNote(pitch, lengthAfter(at, defaultLength) as number, at);
      continue;
    }
    switch (c) {
      case 'R':
        addRest(lengthAfter(at, defaultLength) as number, at);
        break;
      case 'N': {
        const n = range(number(), 0, 96, at, 'N');
        warn.add('W_DIALECT_N', 'N の番号は N1 = O1C（N0 = 休符）と仮定して変換しました（推定）。', at);
        if (n === 0) addRest(defaultLength, at);
        else addNote(23 + n, defaultLength, at);
        break;
      }
      case 'L': {
        defaultLength = lengthAfter(at, null) ?? err('E_DIALECT_VALUE', 'L の後に音長が必要です。', at.line, at.column);
        events.push({ kind: 'defaultLength', ticks: defaultLength, line: at.lineLabel });
        break;
      }
      case 'O':
        octave = range(number(), 0, 9, at, 'O');
        break;
      case '>':
        octave++;
        if (octave > 9) err('E_DIALECT_RANGE', 'オクターブが範囲外になります。', at.line, at.column);
        break;
      case '<':
        octave--;
        if (octave < 0) err('E_DIALECT_RANGE', 'オクターブが範囲外になります。', at.line, at.column);
        break;
      case 'T':
        events.push({ kind: 'tempo', tick, bpm: range(number(), 32, 255, at, 'T'), at });
        break;
      case 'V':
        velocity = Math.round((range(number(), 0, 15, at, 'V') * 127) / 15);
        break;
      case 'Q': {
        const q = range(number(), 1, 8, at, 'Q');
        qPct = Math.round((q * 100) / 8);
        break;
      }
      case '^': {
        const add = lengthAfter(at, null) ?? err('E_DIALECT_VALUE', '^ の後に音長が必要です。', at.line, at.column);
        warn.add('W_DIALECT_CARET', '^ は「直前の音に音長を足す」として変換しました（推定）。', at);
        const target: Extract<PartEvent, { kind: 'note' | 'rest' }> | null = lastNote ?? lastRest;
        if (!target) err('E_DIALECT_SYNTAX', '^ の前に音符か休符が必要です。', at.line, at.column);
        target.duration += add;
        if (target.kind === 'note' && !target.tiedToDifferent) target.gate = gateOf(target.duration, target.qPct);
        tick += add;
        break;
      }
      case '&':
        if (!lastNote) err('E_DIALECT_SYNTAX', '& の前に音符が必要です。', at.line, at.column);
        tiePending = at;
        break;
      case '{': {
        // Tuplet: x-th note divided equally among the notes / rests inside.
        const items: Array<{ pitch: number | null; at: Char }> = [];
        let o = octave;
        for (;;) {
          if (p >= chars.length) err('E_DIALECT_SYNTAX', '連符 { が } で閉じられていません。', at.line, at.column);
          const it = chars[p++];
          if (it.ch === '}') break;
          if (it.ch in SEMITONES) items.push({ pitch: pitchOf(it.ch, it, o), at: it });
          else if (it.ch === 'R') items.push({ pitch: null, at: it });
          else if (it.ch === '>') o++;
          else if (it.ch === '<') o--;
          else if (it.ch === 'O') o = range(number(), 0, 9, it, 'O');
          else err('E_DIALECT_SYNTAX', `連符の中に書けない文字です: ${it.ch}`, it.line, it.column);
          if (isDigit(peek()) || peek() === '.') {
            while (isDigit(peek()) || peek() === '.') p++;
            warn.add('W_DIALECT_TUPLET_LENGTH', '連符の中の個別の音長は無視しました（{ } の後の音長で等分します）。', it);
          }
        }
        octave = o;
        if (items.length === 0) err('E_DIALECT_SYNTAX', '連符 { } の中に音符がありません。', at.line, at.column);
        let total = lengthAfter(at, null);
        if (total === null) {
          total = defaultLength;
          warn.add('W_DIALECT_TUPLET_DEFAULT', '音長を省略した連符は現在の L の長さで等分しました（推定）。', at);
        }
        const base = Math.floor(total / items.length);
        const extra = total - base * items.length;
        items.forEach((item, k) => {
          const d = base + (k < extra ? 1 : 0);
          if (d <= 0) err('E_DIALECT_RANGE', '連符の音が短すぎます。', item.at.line, item.at.column);
          if (item.pitch === null) addRest(d, item.at);
          else addNote(item.pitch, d, item.at);
        });
        break;
      }
      case '@': {
        const next = peek();
        if (next === 'V') {
          p++;
          velocity = range(number(), 0, 127, at, '@V');
        } else if (next === 'M' || next === 'L' || next === 'R') {
          p++;
          warn.add('W_DIALECT_PAN', '@M / @L / @R（左右の出力）は変換しません。', at);
        } else if (next === 'W') {
          p++;
          const d = lengthAfter(at, defaultLength) as number;
          warn.add('W_DIALECT_WAIT', '@W は同じ長さの休符として変換しました（推定）。', at);
          addRest(d, at);
        } else {
          const fm = range(number(), 0, 81, at, '@');
          events.push({ kind: 'program', tick, fm, line: at.lineLabel });
        }
        break;
      }
      case 'M':
        if (peek() === 'B' || peek() === 'F') {
          p++; // background / foreground: no musical meaning
        } else {
          number();
          warn.add('W_DIALECT_ENVELOPE', 'M / S（SSG エンベロープ）は変換しません。', at);
        }
        break;
      case 'S':
        number();
        warn.add('W_DIALECT_ENVELOPE', 'M / S（SSG エンベロープ）は変換しません。', at);
        break;
      case 'Y':
        skipArgs();
        warn.add('W_DIALECT_REGISTER', 'Y（音源レジスタへの書き込み）は変換しません。', at);
        break;
      case 'Z':
        skipArgs();
        warn.add('W_DIALECT_Z', 'Z は意味が確認できないため読み飛ばしました。', at);
        break;
      default:
        err('E_DIALECT_CHAR', `変換できない文字です: ${c}`, at.line, at.column);
    }
  }
  return { events, endTick: tick };
}

/* ------------------------------------------------------------------ MML writer */

function singleToken(ticks: number): string | null {
  for (const [t, s] of LENGTH_TOKENS) if (t === ticks) return s;
  return null;
}

function lengthParts(ticks: number): string[] | null {
  const parts: string[] = [];
  let rest = ticks;
  while (rest > 0) {
    const e = LENGTH_TOKENS.find(([t]) => t <= rest);
    if (!e) return null;
    parts.push(e[1]);
    rest -= e[0];
    if (parts.length > 32) return null;
  }
  return parts;
}

function timeOf(tick: number): string {
  const m = Math.floor(tick / WHOLE) + 1;
  const rest = tick % WHOLE;
  return `Time(${m}:${Math.floor(rest / PPQ) + 1}:${rest % PPQ})`;
}

function voiceFor(fm: number) {
  return FM_VOICES[fm];
}

interface ExpectedNote {
  channel: number;
  pitch: number;
  start: number;
  gate: number;
  velocity: number;
}

function writePart(index: number, part: PartResult, out: string[], expected: ExpectedNote[]): number {
  const n = index + 1;
  const ssg = n >= 4;
  const notes = part.events.filter((e) => e.kind === 'note').length;
  const programs = part.events.filter((e): e is Extract<PartEvent, { kind: 'program' }> => e.kind === 'program');
  out.push('');
  out.push(`// パート${n}${ssg ? '（SSG）' : '（FM）'}`);
  const used = [...new Set(programs.map((x) => x.fm))];
  for (const fm of used) {
    const v = voiceFor(fm);
    out.push(`// @${fm} ${v.name} → @${v.gm} ${v.gmName}`);
  }
  const header = [`TR(${n})`, `CH(${n})`];
  const firstProgramAtZero = programs.length > 0 && programs[0].tick === 0;
  if (!firstProgramAtZero) header.push(ssg ? `@${SSG_DEFAULT_GM.gm}` : `@${voiceFor(0).gm}`);
  if (!firstProgramAtZero) out.push(`// 初期音色: ${ssg ? `SSG → @${SSG_DEFAULT_GM.gm} ${SSG_DEFAULT_GM.gmName}` : `@0 ${voiceFor(0).name} → @${voiceFor(0).gm} ${voiceFor(0).gmName}`}`);
  header.push('q100');
  out.push(header.join(' '));

  let octave: number | null = null;
  let defaultLength: number = PPQ;
  let velocity = 100;
  let qPct = 100;
  let line = '';
  let tokens: string[] = [];
  const flush = () => {
    if (tokens.length > 0) out.push(`${tokens.join(' ')}  // ${line}`);
    tokens = [];
  };
  const lengthText = (d: number) => {
    if (d === defaultLength) return '';
    const s = singleToken(d);
    if (s) return s;
    const parts = lengthParts(d);
    return parts ? parts.join('^') : `%${d}`;
  };
  for (const e of part.events) {
    if (e.kind === 'tempo') continue;
    if (e.line !== line) {
      flush();
      line = e.line;
    }
    switch (e.kind) {
      case 'program':
        tokens.push(`@${voiceFor(e.fm).gm}`);
        break;
      case 'defaultLength': {
        const s = singleToken(e.ticks);
        tokens.push(s ? `l${s}` : `l%${e.ticks}`);
        defaultLength = e.ticks;
        break;
      }
      case 'rest': {
        if (e.duration === defaultLength) tokens.push('r');
        else {
          const parts = lengthParts(e.duration);
          tokens.push(parts ? parts.map((x) => `r${x}`).join('') : `r%${e.duration}`);
        }
        break;
      }
      case 'note': {
        let t = '';
        if (e.velocity !== velocity) {
          t += `v${e.velocity} `;
          velocity = e.velocity;
        }
        const pct = e.tiedToDifferent ? 100 : e.qPct;
        if (pct !== qPct) {
          t += `q${pct} `;
          qPct = pct;
        }
        if (e.pitch >= 12) {
          const o = Math.floor(e.pitch / 12) - 1;
          if (octave === null || Math.abs(o - octave) > 1) t += `o${o} `;
          else if (o === octave + 1) t += '>';
          else if (o === octave - 1) t += '<';
          octave = o;
          t += NAMES[e.pitch % 12] + lengthText(e.duration);
        } else {
          t += `n${e.pitch}%${e.duration}`;
        }
        tokens.push(t);
        const gate = gateOf(e.duration, pct);
        if (gate > 0 && e.velocity > 0) expected.push({ channel: index, pitch: e.pitch, start: e.start, gate, velocity: e.velocity });
        break;
      }
    }
  }
  flush();
  return notes;
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
      err('E_DIALECT_NO_DATA', '変換できる演奏データ（「行番号 "…","…"」の行）がありません。', 1, 1);
    }
    const warn = new Warnings();
    const parts = song.parts.map((segs) => interpretPart(segs, warn));

    // Tempo is global (SPEC 3.6): the first part that writes T is the reference.
    const base = parts.findIndex((pt) => pt.events.some((e) => e.kind === 'tempo'));
    const tempos = new Map<number, number>();
    if (base >= 0) {
      for (const e of parts[base].events) if (e.kind === 'tempo') tempos.set(e.tick, e.bpm);
      parts.forEach((pt, i) => {
        if (i === base) return;
        for (const e of pt.events) {
          if (e.kind === 'tempo' && tempos.get(e.tick) !== e.bpm) {
            warn.add('W_DIALECT_TEMPO', `パート${i + 1} のテンポ T${e.bpm} は、パート${base + 1} のテンポと合わないため無視しました（テンポは曲全体で共通）。`, e.at);
          }
        }
      });
    }

    const out: string[] = [];
    out.push(`// PC-9801 PLAY から変換${song.title ? `: ${song.title.replace(/[\r\n]/g, ' ')}` : ''}`);
    out.push('// 音色は GM の近い音色に置き換えています。SSG のエンベロープ等は再現しません。');
    out.push('// 行末の // の後の数字は元の行番号です。');
    out.push('');
    out.push('TR(0)');
    for (const [tick, bpm] of [...tempos.entries()].sort((a, b) => a[0] - b[0])) out.push(`${timeOf(tick)} Tempo(${bpm})`);
    const expected: ExpectedNote[] = [];
    let noteCount = 0;
    let written = 0;
    parts.forEach((pt, i) => {
      // An empty part ("") produces no track.
      if (!pt.events.some((e) => e.kind === 'note')) return;
      noteCount += writePart(i, pt, out, expected);
      written++;
    });
    const mml = out.join('\n') + '\n';

    // Recompile and verify (SPEC 4.5.2).
    const compiled = compileMml(mml);
    if (!compiled.ok) {
      const d = compiled.diagnostics[0];
      return { ok: false, errors: [{ code: 'E_DIALECT_VERIFY', message: `変換結果の MML がコンパイルできませんでした（${d.code}: ${d.message}）。`, line: 1, column: 1 }] };
    }
    const actual = compiled.song.tracks
      .flatMap((t) => t.events)
      .filter((e): e is NoteEvent => e.kind === 'note')
      .map((e) => ({ channel: e.channel, pitch: e.pitch, start: e.startTick, gate: e.gateTicks, velocity: e.velocity }));
    const key = (x: ExpectedNote) => `${x.channel}:${x.start}:${x.pitch}:${x.gate}:${x.velocity}`;
    const a = actual.map(key).sort();
    const b = expected.map(key).sort();
    const verified = a.length === b.length && a.every((k, i) => k === b[i]);
    if (!verified) {
      return { ok: false, errors: [{ code: 'E_DIALECT_VERIFY', message: `変換結果を再コンパイルした音符が、変換器の想定と一致しませんでした（${a.length} / ${b.length} 音）。`, line: 1, column: 1 }] };
    }
    return { ok: true, mml, warnings: warn.list(), summary: { dialect: 'pc98-play', parts: written, notes: noteCount, verified } };
  } catch (e) {
    if (e instanceof DialectError) return { ok: false, errors: [e.issue] };
    throw e;
  }
}
