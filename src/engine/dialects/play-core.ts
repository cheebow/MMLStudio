// Shared core for the BASIC `PLAY` MML of N88-BASIC (PC-9801 / PC-8801) and MSX-BASIC (SPEC 4.5.3 - 4.5.5, 4.5.14 - 4.5.16).
// Hand-written. The output is plain MML Studio syntax (SPEC 3); the converter verifies it by recompiling.
import { compileMml } from '../compiler';
import { PPQ, type NoteEvent } from '../types';
import type { DialectConvertResult, DialectId, DialectWarning } from './types';

const WHOLE = PPQ * 4;
const SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};
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

/* ------------------------------------------------------------------ inputs */

export interface Segment {
  /** 1-based source line */
  line: number;
  /** 1-based column of the first character */
  column: number;
  text: string;
  /** shown as `// label` after the output line (the BASIC line number) */
  lineLabel: string;
}

export type PartKind = 'fm' | 'psg' | 'rhythm' | 'midi';

export interface PlayPart {
  kind: PartKind;
  /** heading comment of the output track, e.g. `パート1（FM）` */
  name: string;
  segments: Segment[];
  /** voice in effect before the first `@` (CALL VOICE); undefined = the machine default */
  initialVoice?: number;
  /** MIDI channel to use (default: parts in order, skipping 10) */
  channel?: number;
}

export interface VoiceInfo {
  name: string;
  /** MML Studio @N (1..128) */
  gm: number;
  gmName: string;
}

export interface PlayProfile {
  dialect: DialectId;
  /** `PC-9801 PLAY` -> `// PC-9801 PLAY から変換` */
  label: string;
  /** FM voice number -> GM (undefined when out of the table) */
  fmVoice(n: number): VoiceInfo | undefined;
  fmVoiceMax: number;
  /** GM voice used for PSG / SSG parts */
  psgVoice: VoiceInfo;
  /** `SSG` (N88) / `PSG` (MSX) */
  psgLabel: string;
  /** PSG parts accept `@x` (N88: the SSG parts use the FM table) */
  psgAcceptsVoice: boolean;
  /** comment written under the title */
  note: string;
  /** MSX: every dot multiplies by 1.5 (`..` = 9/4); N88: each dot adds half of the previous addition (`..` = 7/4) */
  dotsMultiply?: boolean;
  /** MSX: Q has no effect on PSG parts */
  psgIgnoresQ?: boolean;
}

export class PlayError extends Error {
  constructor(readonly issue: DialectWarning) {
    super(issue.message);
  }
}

export function playErr(code: string, message: string, line: number, column: number): never {
  throw new PlayError({ code, message, line, column });
}

export class PlayWarnings {
  private readonly map = new Map<string, DialectWarning>();
  add(code: string, message: string, at: { line: number; column: number }): void {
    const key = `${code}\u0000${message}`;
    const w = this.map.get(key);
    if (w) w.count = (w.count ?? 1) + 1;
    else
      this.map.set(key, {
        code,
        message,
        line: at.line,
        column: at.column,
        count: 1,
      });
  }
  list(): DialectWarning[] {
    return [...this.map.values()].sort((a, b) => a.line - b.line || a.column - b.column);
  }
}

/* ------------------------------------------------------------------ MML interpretation */

interface Char {
  ch: string;
  line: number;
  column: number;
  lineLabel: string;
}

type PartEvent =
  | {
      kind: 'note';
      pitches: number[];
      start: number;
      duration: number;
      gate: number;
      velocity: number;
      qPct: number;
      line: string;
      at: Char;
      tiedToDifferent?: boolean;
    }
  | { kind: 'rest'; start: number; duration: number; line: string }
  | { kind: 'program'; tick: number; voice: number; line: string }
  | { kind: 'tempo'; tick: number; bpm: number; at: Char }
  | { kind: 'defaultLength'; ticks: number; line: string };

interface PartResult {
  events: PartEvent[];
  endTick: number;
}

function gateOf(duration: number, qPct: number): number {
  let gate = Math.round((duration * qPct) / 100);
  if (qPct > 0 && gate < 1) gate = 1;
  return gate;
}

function toChars(segments: Segment[]): Char[] {
  const chars: Char[] = [];
  for (const s of segments) {
    for (let k = 0; k < s.text.length; k++) {
      const c = s.text[k];
      if (c === ' ' || c === '\t') continue; // spaces are ignored (SPEC 4.5.3)
      chars.push({
        ch: c.toUpperCase(),
        line: s.line,
        column: s.column + k,
        lineLabel: s.lineLabel,
      });
    }
  }
  return chars;
}

/** MSX FM rhythm voices (SPEC 4.5.15): B S M C H -> GM drum notes */
const RHYTHM_NOTES: Record<string, number> = {
  B: 36,
  S: 38,
  M: 45,
  C: 49,
  H: 42,
};

function interpretPart(part: PlayPart, profile: PlayProfile, warn: PlayWarnings, bestEffort = false): PartResult {
  const chars = toChars(part.segments);
  let p = 0;
  const peek = () => chars[p]?.ch ?? '';
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const number = (): number | null => {
    if (!isDigit(peek())) return null;
    let v = 0;
    while (isDigit(peek())) v = v * 10 + Number(chars[p++].ch);
    return v;
  };

  const rhythm = part.kind === 'rhythm';
  let octave = 4;
  let defaultLength: number = PPQ;
  let velocity = Math.round((8 * 127) / 15);
  let accent = 127;
  let qPct = 100;
  let tick = 0;
  const events: PartEvent[] = [];
  // `as` keeps the declared union type (they are reassigned inside the helper closures).
  let lastNote = null as Extract<PartEvent, { kind: 'note' }> | null;
  let lastRest = null as Extract<PartEvent, { kind: 'rest' }> | null;
  let tiePending = null as Char | null;

  const range = (v: number | null, lo: number, hi: number, at: Char, what: string): number => {
    if (v === null) playErr('E_DIALECT_VALUE', `${what} の後に数値が必要です。`, at.line, at.column);
    if (v < lo || v > hi) playErr('E_DIALECT_RANGE', `${what}${v} は範囲外です（${lo}〜${hi}）。`, at.line, at.column);
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
      if (profile.dotsMultiply) ticks *= 1.5;
      else {
        ticks += add;
        add /= 2;
      }
    }
    if (dots >= 2 && !profile.dotsMultiply) warn.add('W_DIALECT_DOTS', '付点 2 個以上は「直前の加算分の半分を足す」として変換しました（推定）。', at);
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
    if (pitch < 0 || pitch > 127) playErr('E_DIALECT_RANGE', `音高が MIDI の範囲を超えています（${pitch}）。`, at.line, at.column);
    return pitch;
  };
  const addNote = (pitches: number[], duration: number, at: Char, vel = velocity) => {
    // `&` tie: same pitch extends the previous note; a different pitch is played legato.
    if (tiePending && lastNote) {
      if (lastNote.pitches.length === pitches.length && lastNote.pitches.every((x, i) => x === pitches[i]) && lastNote.start + lastNote.duration === tick) {
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
    const note: Extract<PartEvent, { kind: 'note' }> = {
      kind: 'note',
      pitches,
      start: tick,
      duration,
      gate: gateOf(duration, qPct),
      velocity: vel,
      qPct,
      line: at.lineLabel,
      at,
    };
    events.push(note);
    lastNote = note;
    lastRest = null;
    tick += duration;
  };
  const addRest = (duration: number, at: Char) => {
    tiePending = null;
    const r: Extract<PartEvent, { kind: 'rest' }> = {
      kind: 'rest',
      start: tick,
      duration,
      line: at.lineLabel,
    };
    events.push(r);
    lastRest = r;
    lastNote = null;
    tick += duration;
  };
  const skipArgs = () => {
    // digits and commas (e.g. Z0,3 / Y1,2)
    while (isDigit(peek()) || peek() === ',') p++;
  };

  // FM rhythm (MSX): letters collect instruments; a number (or the end) sounds them and waits
  let pendingDrums: Array<{ pitch: number; accent: boolean; at: Char }> = [];
  const flushDrums = (duration: number, at: Char) => {
    if (pendingDrums.length === 0) {
      addRest(duration, at);
      return;
    }
    const pitches = [...new Set(pendingDrums.map((d) => d.pitch))].sort((a, b) => a - b);
    const accented = pendingDrums.some((d) => d.accent);
    addNote(pitches, duration, pendingDrums[0].at, accented ? accent : velocity);
    pendingDrums = [];
  };

  while (p < chars.length) {
    const at = chars[p++];
    const c = at.ch;
    try {
      if (rhythm && c in RHYTHM_NOTES) {
        pendingDrums.push({ pitch: RHYTHM_NOTES[c], accent: false, at });
        if (peek() === '!') {
          p++;
          pendingDrums[pendingDrums.length - 1].accent = true;
          warn.add('W_MSX_ACCENT', 'リズムの ! （アクセント）は @A の音量で鳴らしました（@A の初期値は 15 と仮定・推定）。', at);
        }
        if (isDigit(peek()) || peek() === '.') flushDrums(lengthAfter(at, defaultLength) as number, at);
        continue;
      }
      if (rhythm && c === '!') {
        // accent written after the length (`S8!`): the note just played
        if (pendingDrums.length) pendingDrums[pendingDrums.length - 1].accent = true;
        else if (lastNote) lastNote.velocity = accent;
        warn.add('W_MSX_ACCENT', 'リズムの ! （アクセント）は @A の音量で鳴らしました（@A の初期値は 15 と仮定・推定）。', at);
        continue;
      }
      if (rhythm && isDigit(c)) {
        p--;
        flushDrums(lengthAfter(at, defaultLength) as number, at);
        continue;
      }
      if (rhythm && pendingDrums.length && !(c in RHYTHM_NOTES) && c !== '!') flushDrums(defaultLength, at);
      if (!rhythm && c in SEMITONES) {
        const pitch = pitchOf(c, at);
        addNote([pitch], lengthAfter(at, defaultLength) as number, at);
        continue;
      }
      switch (c) {
        case 'R':
          addRest(lengthAfter(at, defaultLength) as number, at);
          break;
        case 'N': {
          const n = range(number(), 0, 96, at, 'N');
          warn.add('W_DIALECT_N', 'N の番号は N1 = O1C（N0 = 休符）と仮定して変換しました（推定）。', at);
          const d = lengthAfter(at, defaultLength) as number;
          if (n === 0) addRest(d, at);
          else addNote([23 + n], d, at);
          break;
        }
        case 'L': {
          defaultLength = lengthAfter(at, null) ?? playErr('E_DIALECT_VALUE', 'L の後に音長が必要です。', at.line, at.column);
          events.push({
            kind: 'defaultLength',
            ticks: defaultLength,
            line: at.lineLabel,
          });
          break;
        }
        case 'O':
          octave = range(number(), 0, 9, at, 'O');
          break;
        case '>':
          octave++;
          if (octave > 9) playErr('E_DIALECT_RANGE', 'オクターブが範囲外になります。', at.line, at.column);
          break;
        case '<':
          octave--;
          if (octave < 0) playErr('E_DIALECT_RANGE', 'オクターブが範囲外になります。', at.line, at.column);
          break;
        case 'T':
          events.push({
            kind: 'tempo',
            tick,
            bpm: range(number(), 32, 255, at, 'T'),
            at,
          });
          break;
        case 'V':
          velocity = Math.round((range(number(), 0, 15, at, 'V') * 127) / 15);
          break;
        case 'Q': {
          const q = range(number(), 1, 8, at, 'Q');
          if (part.kind === 'psg' && profile.psgIgnoresQ) warn.add('W_MSX_PSG_Q', 'PSG パートの Q は効果が無いため無視しました。', at);
          else qPct = Math.round((q * 100) / 8);
          break;
        }
        case '^': {
          const add = lengthAfter(at, null) ?? playErr('E_DIALECT_VALUE', '^ の後に音長が必要です。', at.line, at.column);
          warn.add('W_DIALECT_CARET', '^ は「直前の音に音長を足す」として変換しました（推定）。', at);
          const target: Extract<PartEvent, { kind: 'note' | 'rest' }> | null = lastNote ?? lastRest;
          if (!target) playErr('E_DIALECT_SYNTAX', '^ の前に音符か休符が必要です。', at.line, at.column);
          target.duration += add;
          if (target.kind === 'note' && !target.tiedToDifferent) target.gate = gateOf(target.duration, target.qPct);
          tick += add;
          break;
        }
        case '&':
          if (!lastNote) playErr('E_DIALECT_SYNTAX', '& の前に音符が必要です。', at.line, at.column);
          tiePending = at;
          break;
        case '{': {
          // Tuplet: x-th note divided equally among the notes / rests inside.
          const items: Array<{ pitch: number | null; at: Char }> = [];
          let o = octave;
          for (;;) {
            if (p >= chars.length) playErr('E_DIALECT_SYNTAX', '連符 { が } で閉じられていません。', at.line, at.column);
            const it = chars[p++];
            if (it.ch === '}') break;
            if (it.ch in SEMITONES) items.push({ pitch: pitchOf(it.ch, it, o), at: it });
            else if (it.ch === 'R') items.push({ pitch: null, at: it });
            else if (it.ch === '>') o++;
            else if (it.ch === '<') o--;
            else if (it.ch === 'O') o = range(number(), 0, 9, it, 'O');
            else playErr('E_DIALECT_SYNTAX', `連符の中に書けない文字です: ${it.ch}`, it.line, it.column);
            if (isDigit(peek()) || peek() === '.') {
              while (isDigit(peek()) || peek() === '.') p++;
              warn.add('W_DIALECT_TUPLET_LENGTH', '連符の中の個別の音長は無視しました（{ } の後の音長で等分します）。', it);
            }
          }
          octave = o;
          if (items.length === 0) playErr('E_DIALECT_SYNTAX', '連符 { } の中に音符がありません。', at.line, at.column);
          let total = lengthAfter(at, null);
          if (total === null) {
            total = defaultLength;
            warn.add('W_DIALECT_TUPLET_DEFAULT', '音長を省略した連符は現在の L の長さで等分しました（推定）。', at);
          }
          const base = Math.floor(total / items.length);
          const extra = total - base * items.length;
          items.forEach((item, k) => {
            const d = base + (k < extra ? 1 : 0);
            if (d <= 0) playErr('E_DIALECT_RANGE', '連符の音が短すぎます。', item.at.line, item.at.column);
            if (item.pitch === null) addRest(d, item.at);
            else addNote([item.pitch], d, item.at);
          });
          break;
        }
        case '@': {
          const next = peek();
          if (next === 'V') {
            p++;
            velocity = range(number(), 0, 127, at, '@V');
          } else if (next === 'A') {
            p++;
            accent = Math.round((range(number(), 0, 15, at, '@A') * 127) / 15);
          } else if (next === 'M' || next === 'L' || next === 'R') {
            p++;
            warn.add('W_DIALECT_PAN', '@M / @L / @R（左右の出力）は変換しません。', at);
          } else if (next === 'W') {
            p++;
            const d = lengthAfter(at, defaultLength) as number;
            warn.add('W_DIALECT_WAIT', '@W は同じ長さの休符として変換しました（推定）。', at);
            addRest(d, at);
          } else if (next === 'C' || next === 'H' || next === 'S') {
            p++;
            skipArgs();
            warn.add('W_MSX_MIDI_CMD', '@C / @H / @S（MIDI の制御）は変換しません。', at);
          } else if (rhythm) {
            number();
            warn.add('W_MSX_RHYTHM_VOICE', 'リズムパートの @ は変換しません。', at);
          } else if (part.kind === 'psg' && !profile.psgAcceptsVoice) {
            number();
            warn.add('W_MSX_PSG_VOICE', 'PSG パートの @（音色）は使えないため無視しました。', at);
          } else {
            const max = part.kind === 'midi' ? 127 : profile.fmVoiceMax;
            const voice = range(number(), 0, max, at, '@');
            events.push({ kind: 'program', tick, voice, line: at.lineLabel });
          }
          break;
        }
        case 'M':
          if (peek() === 'B' || peek() === 'F') {
            p++; // background / foreground: no musical meaning
          } else {
            number();
            warn.add('W_DIALECT_ENVELOPE', `M / S（${profile.psgLabel} エンベロープ）は変換しません。`, at);
          }
          break;
        case 'S':
          number();
          warn.add('W_DIALECT_ENVELOPE', `M / S（${profile.psgLabel} エンベロープ）は変換しません。`, at);
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
          playErr('E_DIALECT_CHAR', `変換できない文字です: ${c}`, at.line, at.column);
      }
    } catch (e) {
      if (!bestEffort || !(e instanceof PlayError)) throw e;
      warn.add('W_DIALECT_APPROX', `${e.issue.message}（近似変換: スキップしました）`, e.issue);
    }
  }
  if (rhythm && pendingDrums.length) flushDrums(defaultLength, pendingDrums[0].at);
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

interface ExpectedNote {
  channel: number;
  pitch: number;
  start: number;
  gate: number;
  velocity: number;
}

function voiceOf(kind: PartKind, n: number, profile: PlayProfile): VoiceInfo {
  if (kind === 'midi') return { name: `MIDI ${n}`, gm: n + 1, gmName: '' };
  return profile.fmVoice(n) ?? profile.psgVoice;
}

/** Writes one part as `TR(track) CH(channel)`; returns the number of notes. */
function writePart(track: number, channel: number, part: PlayPart, result: PartResult, profile: PlayProfile, out: string[], expected: ExpectedNote[]): number {
  const drum = channel === 10;
  const notes = result.events.reduce((n, e) => n + (e.kind === 'note' ? e.pitches.length : 0), 0);
  const programs = result.events.filter((e): e is Extract<PartEvent, { kind: 'program' }> => e.kind === 'program');
  out.push('');
  out.push(`// ${part.name}`);
  if (!drum) {
    const used = [...new Set(programs.map((x) => x.voice))];
    for (const n of used) {
      const v = voiceOf(part.kind, n, profile);
      if (part.kind !== 'midi') out.push(`// @${n} ${v.name} → @${v.gm} ${v.gmName}`);
    }
  }
  const header = [`TR(${track})`, `CH(${channel})`];
  const firstProgramAtZero = programs.length > 0 && programs[0].tick === 0;
  if (!drum && !firstProgramAtZero) {
    if (part.kind === 'psg' && part.initialVoice === undefined) {
      header.push(`@${profile.psgVoice.gm}`);
      out.push(`// 初期音色: ${profile.psgLabel} → @${profile.psgVoice.gm} ${profile.psgVoice.gmName}`);
    } else {
      const n = part.initialVoice ?? 0;
      const v = voiceOf(part.kind, n, profile);
      header.push(`@${v.gm}`);
      const from = part.initialVoice !== undefined ? 'CALL VOICE ' : '';
      out.push(`// 初期音色: ${from}${part.kind === 'midi' ? `@${n}` : `@${n} ${v.name}`} → @${v.gm} ${v.gmName}`.trimEnd());
    }
  }
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
  for (const e of result.events) {
    if (e.kind === 'tempo') continue;
    if (e.line !== line) {
      flush();
      line = e.line;
    }
    switch (e.kind) {
      case 'program':
        if (!drum) tokens.push(`@${voiceOf(part.kind, e.voice, profile).gm}`);
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
        if (e.pitches.length > 1) {
          const len = lengthText(e.duration);
          t += `'${e.pitches.map((x) => `n${x}`).join(' ')}'${len.includes('^') ? `%${e.duration}` : len}`;
        } else if (e.pitches[0] >= 12) {
          const pitch = e.pitches[0];
          const o = Math.floor(pitch / 12) - 1;
          if (octave === null || Math.abs(o - octave) > 1) t += `o${o} `;
          else if (o === octave + 1) t += '>';
          else if (o === octave - 1) t += '<';
          octave = o;
          t += NAMES[pitch % 12] + lengthText(e.duration);
        } else {
          t += `n${e.pitches[0]}%${e.duration}`;
        }
        tokens.push(t);
        const gate = gateOf(e.duration, pct);
        if (gate > 0 && e.velocity > 0)
          for (const pitch of e.pitches)
            expected.push({
              channel: channel - 1,
              pitch,
              start: e.start,
              gate,
              velocity: e.velocity,
            });
        break;
      }
    }
  }
  flush();
  return notes;
}

/** MIDI channel for each part: 1, 2, ... skipping 10; rhythm parts use 10. */
function channelsFor(parts: PlayPart[]): number[] {
  let next = 1;
  return parts.map((p) => {
    if (p.channel !== undefined) return p.channel;
    if (p.kind === 'rhythm') return 10;
    if (next === 10) next++;
    return next++;
  });
}

/**
 * Interprets the parts, writes MML Studio MML and verifies it by recompiling (SPEC 4.5.2).
 * Tempo is global (SPEC 3.6): the first part that writes T is the reference.
 */
export function convertPlayParts(
  parts: PlayPart[],
  profile: PlayProfile,
  title: string | undefined,
  warn: PlayWarnings,
  options: {
    extraNotes?: string[];
    bestEffort?: boolean;
    approximate?: boolean;
  } = {},
): DialectConvertResult {
  const results = parts.map((pt) => interpretPart(pt, profile, warn, options.bestEffort));
  const extraNotes = options.extraNotes ?? [];
  const approximate = !!options.approximate || warn.list().some((w) => w.code.endsWith('_APPROX'));
  if (approximate) extraNotes.unshift('近似変換: 変換できない命令をスキップしています（元の曲と同じには鳴りません）。');
  const base = results.findIndex((pt) => pt.events.some((e) => e.kind === 'tempo'));
  const tempos = new Map<number, number>();
  if (base >= 0) {
    for (const e of results[base].events) if (e.kind === 'tempo') tempos.set(e.tick, e.bpm);
    results.forEach((pt, i) => {
      if (i === base) return;
      for (const e of pt.events) {
        if (e.kind === 'tempo' && tempos.get(e.tick) !== e.bpm) {
          const short = (n: string) => n.replace(/（.*）$/, '');
          warn.add(
            'W_DIALECT_TEMPO',
            `${short(parts[i].name)} のテンポ T${e.bpm} は、${short(parts[base].name)} のテンポと合わないため無視しました（テンポは曲全体で共通）。`,
            e.at,
          );
        }
      }
    });
  }

  const out: string[] = [];
  out.push(`// ${profile.label} から変換${title ? `: ${title.replace(/[\r\n]/g, ' ')}` : ''}`);
  out.push(`// ${profile.note}`);
  for (const n of extraNotes) out.push(`// ${n}`);
  out.push('// 行末の // の後の数字は元の行番号です。');
  out.push('');
  out.push('TR(0)');
  for (const [tick, bpm] of [...tempos.entries()].sort((a, b) => a[0] - b[0])) out.push(`${timeOf(tick)} Tempo(${bpm})`);
  const expected: ExpectedNote[] = [];
  let noteCount = 0;
  let written = 0;
  const channels = channelsFor(parts);
  results.forEach((pt, i) => {
    // A part without notes produces no track.
    if (!pt.events.some((e) => e.kind === 'note')) return;
    written++;
    noteCount += writePart(channels[i], channels[i], parts[i], pt, profile, out, expected);
  });
  if (noteCount === 0) playErr('E_DIALECT_NO_DATA', '演奏する音符がありません。', 1, 1);
  const mml = out.join('\n') + '\n';

  const compiled = compileMml(mml);
  if (!compiled.ok) {
    const d = compiled.diagnostics[0];
    return {
      ok: false,
      errors: [
        {
          code: 'E_DIALECT_VERIFY',
          message: `変換結果の MML がコンパイルできませんでした（${d.code}: ${d.message}）。`,
          line: 1,
          column: 1,
        },
      ],
    };
  }
  const actual = compiled.song.tracks
    .flatMap((t) => t.events)
    .filter((e): e is NoteEvent => e.kind === 'note')
    .map((e) => ({
      channel: e.channel,
      pitch: e.pitch,
      start: e.startTick,
      gate: e.gateTicks,
      velocity: e.velocity,
    }));
  const key = (x: ExpectedNote) => `${x.channel}:${x.start}:${x.pitch}:${x.gate}:${x.velocity}`;
  const a = actual.map(key).sort();
  const b = expected.map(key).sort();
  const verified = a.length === b.length && a.every((k, i) => k === b[i]);
  if (!verified) {
    return {
      ok: false,
      errors: [
        {
          code: 'E_DIALECT_VERIFY',
          message: `変換結果を再コンパイルした音符が、変換器の想定と一致しませんでした（${a.length} / ${b.length} 音）。`,
          line: 1,
          column: 1,
        },
      ],
    };
  }
  return {
    ok: true,
    mml,
    warnings: warn.list(),
    summary: {
      dialect: profile.dialect,
      parts: written,
      notes: noteCount,
      verified,
      approximate,
    },
  };
}
