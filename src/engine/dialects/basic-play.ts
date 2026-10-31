// MSX-BASIC and PC-8801 N88-BASIC music programs -> MML Studio MML (SPEC 4.5.14 - 4.5.16).
// The BASIC subset (basic-program.ts) collects what PLAY / CMD PLAY play per sound channel;
// the MML of each channel is converted by the shared PLAY core (play-core.ts).
import { BasicError, runBasic, type BChar, type BStr, type CallStatement, type PlayCall, type Pos } from './basic-program';
import { N88_PROFILE_BASE } from './pc98-play';
import { MSX_VOICES } from './msx-voices';
import { convertPlayParts, PlayError, PlayWarnings, type PartKind, type PlayPart, type PlayProfile, type Segment } from './play-core';
import type { DialectConvertResult } from './types';

const MAX_MML_CHARS = 2_000_000;

const MSX_PROFILE: PlayProfile = {
  dialect: 'msx-basic',
  label: 'MSX-BASIC PLAY',
  fmVoice: (n) => MSX_VOICES[n],
  fmVoiceMax: 63,
  psgVoice: { name: 'PSG', gm: 81, gmName: 'Lead 1 (square)' },
  psgLabel: 'PSG',
  psgAcceptsVoice: false,
  note: '音色は GM の近い音色に置き換えています。PSG のエンベロープ、FM 音色そのものは再現しません。',
  dotsMultiply: true,
  psgIgnoresQ: true,
};

const PC88_PROFILE: PlayProfile = { ...N88_PROFILE_BASE, dialect: 'pc88-basic', label: 'PC-8801 N88-BASIC PLAY' };

/** One sound channel collected from the program. */
interface Channel {
  key: string;
  kind: PartKind;
  name: string;
  order: number;
  segments: Segment[];
  /** CALL VOICE before the first note of the channel */
  initialVoice?: number;
}

class Collector {
  readonly channels = new Map<string, Channel>();
  private chars = 0;
  constructor(private readonly warn: PlayWarnings) {}

  channel(key: string, kind: PartKind, name: string, order: number): Channel {
    let c = this.channels.get(key);
    if (!c) {
      c = { key, kind, name, order, segments: [] };
      this.channels.set(key, c);
    }
    return c;
  }

  /** appends a string value, keeping the source position of every run of characters */
  append(ch: Channel, s: BStr, at: Pos): void {
    this.chars += s.length;
    if (this.chars > MAX_MML_CHARS) throw new BasicError('E_BASIC_LIMIT', '演奏データが大きすぎます（無限ループの可能性があります）。', at);
    let seg: Segment | null = null;
    let last: BChar | null = null;
    for (const c of s) {
      if (seg && last && c.line === last.line && c.column === last.column + 1 && c.label === last.label) seg.text += c.ch;
      else {
        seg = { line: c.line, column: c.column, text: c.ch, lineLabel: c.label };
        ch.segments.push(seg);
      }
      last = c;
    }
  }

  parts(fixedChannels = false): PlayPart[] {
    return [...this.channels.values()]
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ kind: c.kind, name: c.name, segments: c.segments, initialVoice: c.initialVoice, channel: fixedChannels ? c.order : undefined }));
  }

  warnAt(code: string, message: string, at: Pos): void {
    this.warn.add(code, message, at);
  }
}

/* ------------------------------------------------------------------ MSX */

/** `X A$;` runs a string variable (MSX), `=V;` inserts a number (MSX and N88: `@=T;`). */
function expandVars(s: BStr, vars: (name: string) => number | BStr | undefined, at: Pos, allowX: boolean, depth = 0): BStr {
  if (depth > 16) throw new BasicError('E_BASIC_LIMIT', 'X の展開が深すぎます（自分自身を X で呼んでいる可能性があります）。', at);
  const out: BStr = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const up = c.ch.toUpperCase();
    if ((allowX && up === 'X') || c.ch === '=') {
      const semi = s.findIndex((x, k) => k > i && x.ch === ';');
      if (semi < 0) throw new BasicError('E_MSX_X', `${c.ch} の後の変数名が ; で閉じられていません。`, c);
      const name = s
        .slice(i + 1, semi)
        .map((x) => x.ch)
        .join('')
        .trim()
        .toUpperCase();
      const v = vars(name);
      if (up === 'X') {
        if (v === undefined || typeof v === 'number') throw new BasicError('E_MSX_X', `X で実行する文字列変数 ${name} がありません。`, c);
        out.push(...expandVars(v, vars, at, allowX, depth + 1));
      } else {
        const n = typeof v === 'number' ? v : 0;
        out.push(...[...String(Math.trunc(n))].map((ch) => ({ ...c, ch })));
      }
      i = semi;
      continue;
    }
    out.push(c);
  }
  return out;
}

interface MsxMusic {
  /** 0: 9 melody channels, 1: 6 melody + rhythm */
  mode: number;
  /** FM channels for each melody string */
  counts: number[];
  set: boolean;
}

function msxProgram(text: string, warn: PlayWarnings, bestEffort: boolean): { parts: PlayPart[]; title?: string } {
  const col = new Collector(warn);
  const music: MsxMusic = { mode: 1, counts: [1, 1, 1], set: false };
  const psg = (i: number) => col.channel(`PSG${i}`, 'psg', `PSG${i}`, 300 + i);
  const fm = (i: number) => col.channel(`FM${i}`, 'fm', `FM${i}（MSX-MUSIC）`, 100 + i);
  const midi = (i: number) => col.channel(`MIDI${i}`, 'midi', `MIDI${i}（MSX-MIDI）`, 200 + i);
  const rhythm = (isMidi: boolean) => col.channel(isMidi ? 'MIDIR' : 'FMR', 'rhythm', `リズム（${isMidi ? 'MSX-MIDI' : 'MSX-MUSIC'}）`, 400);

  const onPlay = (call: PlayCall, vars: (name: string) => number | BStr | undefined) => {
    const dev = call.device ?? 0;
    let layout: Array<Channel | null>;
    if (dev === 0) layout = [psg(1), psg(2), psg(3)];
    else if (dev === 1 || dev === 2 || dev === 3) {
      if (!music.set)
        col.warnAt('W_MSX_NO_CALL_MUSIC', `PLAY #${dev} の前に CALL MUSIC が無いため、CALL MUSIC の既定（FM 3 パート＋リズム）として変換しました。`, call.at);
      const isMidi = dev === 1;
      layout = music.counts.map((_, i) => (isMidi ? midi(i + 1) : fm(i + 1)));
      if (music.mode === 1) layout.push(null); // rhythm placeholder (created on use)
      layout.push(psg(1), psg(2), psg(3));
      if (isMidi) col.warnAt('W_MSX_MIDI', 'PLAY #1（MSX-MIDI）の @ は GM の音色番号 + 1 として変換しました。', call.at);
    } else throw new BasicError('E_MSX_DEVICE', `PLAY #${dev} の音源は変換できません（#0〜#3）。`, call.at);
    if (call.args.length > layout.length)
      throw new BasicError('E_MSX_PARTS', `この PLAY の文字列は ${layout.length} 個までです（${call.args.length} 個あります）。`, call.at);
    call.args.forEach((a, i) => {
      if (!a || a.length === 0) return;
      const ch = layout[i] ?? rhythm(dev === 1);
      col.append(ch, expandVars(a, vars, call.at, true), call.at);
    });
  };

  const onCall = (c: CallStatement) => {
    switch (c.name) {
      case 'MUSIC':
      case 'AUDIO': {
        if (c.name === 'AUDIO') col.warnAt('W_MSX_AUDIO', 'CALL AUDIO（MSX-AUDIO）は CALL MUSIC と同じ構成として変換しました（推定）。', c.at);
        const mode = typeof c.args[0] === 'number' ? c.args[0] : 1;
        const counts = c.args.slice(2).map((x) => (typeof x === 'number' && x > 0 ? x : 1));
        music.mode = mode === 0 ? 0 : 1;
        music.counts = counts.length ? counts : [1, 1, 1];
        music.set = true;
        return;
      }
      case 'VOICE': {
        // CALL VOICE(@a,@b,...): voices of FM channels 1, 2, ... -> the strings that use them
        let channel = 0;
        const firstChannel = music.counts.map((n) => {
          const f = channel + 1;
          channel += n;
          return f;
        });
        c.args.forEach((a, k) => {
          if (!a || typeof a === 'number') return;
          const s = firstChannel.indexOf(k + 1);
          if (s < 0) return;
          const ch = fm(s + 1);
          if (ch.segments.length === 0) ch.initialVoice = a.voice;
          else col.append(ch, [...`@${a.voice}`].map((x) => ({ ch: x, line: c.at.line, column: c.at.column, label: c.label })), c.at);
        });
        return;
      }
      case 'KANJI':
      case 'ANK':
      case 'CLS':
        return;
      default:
        col.warnAt('W_MSX_CALL', `CALL ${c.name} は変換しません。`, c.at);
    }
  };

  const { title } = runBasic(text, { nameLength: 2, bestEffort, onPlay, onCall, warn: (code, message, at) => col.warnAt(code, message, at) });
  return { parts: col.parts(), title };
}

/* ------------------------------------------------------------------ PC-8801 */

function pc88Program(text: string, warn: PlayWarnings, bestEffort: boolean): { parts: PlayPart[]; title?: string } {
  const col = new Collector(warn);
  const onPlay = (call: PlayCall, vars: (name: string) => number | BStr | undefined) => {
    const dev = call.device ?? 2;
    let kinds: PartKind[];
    switch (dev) {
      case 2:
        kinds = ['fm', 'fm', 'fm', 'psg', 'psg', 'psg'];
        break;
      case 0:
        kinds = ['psg', 'psg', 'psg', 'psg', 'psg', 'psg'];
        break;
      case 5:
        kinds = ['fm', 'fm', 'fm', 'fm', 'fm', 'fm'];
        break;
      case 1:
        kinds = ['midi', 'midi', 'midi', 'midi', 'midi', 'midi'];
        col.warnAt('W_PC88_MIDI', '#1（MIDI）の @ は GM の音色番号 + 1 として変換しました。', call.at);
        break;
      default:
        throw new BasicError('E_PC88_DEVICE', `${call.command} #${dev}（効果音・CSM モード）は変換できません。`, call.at);
    }
    if (call.args.length > 6) throw new BasicError('E_PC88_PARTS', `${call.command} の文字列は 6 個までです（${call.args.length} 個あります）。`, call.at);
    call.args.forEach((a, i) => {
      if (!a || a.length === 0) return;
      const kind = kinds[i];
      const label = kind === 'fm' ? 'FM' : kind === 'psg' ? 'SSG' : 'MIDI';
      col.append(col.channel(`${kind}${i + 1}`, kind, `チャンネル${i + 1}（${label}）`, i + 1), expandVars(a, vars, call.at, false), call.at);
    });
  };
  const onCall = (c: CallStatement) => col.warnAt('W_PC88_CALL', `CALL ${c.name} は変換しません。`, c.at);
  const { title } = runBasic(text, { cmdPrefix: true, bestEffort, onPlay, onCall, warn: (code, message, at) => col.warnAt(code, message, at) });
  // channel i of CMD PLAY -> CH(i), like PC-9801 (6 channels, never 10)
  return { parts: col.parts(true), title };
}

/* ------------------------------------------------------------------ public API */

function convertProgram(text: string, profile: PlayProfile, run: typeof msxProgram, bestEffort: boolean): DialectConvertResult {
  const warn = new PlayWarnings();
  try {
    const { parts, title } = run(text, warn, bestEffort);
    if (parts.length === 0) {
      return { ok: false, errors: [{ code: 'E_DIALECT_NO_DATA', message: 'PLAY 文で演奏するデータがありません。', line: 1, column: 1 }] };
    }
    return convertPlayParts(parts, profile, title, warn, { bestEffort, extraNotes: title ? ["曲名は最初の REM（'）から取りました。"] : [] });
  } catch (e) {
    if (e instanceof BasicError) return { ok: false, errors: [{ code: e.code, message: e.message, line: e.at.line, column: e.at.column }] };
    if (e instanceof PlayError) return { ok: false, errors: [e.issue] };
    throw e;
  }
}

export function convertMsxBasic(text: string, options: { bestEffort?: boolean } = {}): DialectConvertResult {
  return convertProgram(text, MSX_PROFILE, msxProgram, !!options.bestEffort);
}

export function convertPc88Basic(text: string, options: { bestEffort?: boolean } = {}): DialectConvertResult {
  return convertProgram(text, PC88_PROFILE, pc88Program, !!options.bestEffort);
}

export function basicTitle(text: string): string | undefined {
  const m = /^\s*\d*\s*(?:REM|')\s*(.*\S)/im.exec(text);
  return m && /[^\s*=\-_#/]/.test(m[1]) ? m[1] : undefined;
}
