// Canonical MIDI events -> MML Studio source (SPEC 4.4.3), with recompilation check.
import { compileMml } from './compiler';
import { normalizeMidi } from './midi-normalizer';
import { compareMidiEvents } from './midi-roundtrip';
import { readSmf, type ReadSmfOptions } from './smf-reader';
import { utf8Length } from './source';
import { ticksToSeconds } from './timing';
import type {
  CanonChannel,
  CanonControl,
  CanonNote,
  CanonSong,
  CanonTempo,
  ImportIssue,
  MidiImportOptions,
  MidiImportResult,
  NormalizedMidi,
  ParsedMidi,
  QuantizeGrid,
  QuantizeReport,
} from './midi-types';
import { LIMITS, PPQ } from './types';

const MEASURE = PPQ * 4;
const DRUM_CHANNEL = 9;
export const GRID_TICKS: Record<QuantizeGrid, number> = { '1/8': 240, '1/16': 120, '1/32': 60 };
const NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
/** Single length tokens, longest first. */
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

/** `Time(M:B:S)` for a tick (fixed 4/4 coordinates). */
export function timeOf(tick: number): string {
  const m = Math.floor(tick / MEASURE) + 1;
  const rest = tick % MEASURE;
  return `Time(${m}:${Math.floor(rest / PPQ) + 1}:${rest % PPQ})`;
}

function singleToken(ticks: number): string | null {
  for (const [t, s] of LENGTH_TOKENS) if (t === ticks) return s;
  return null;
}

/** Greedy decomposition into length tokens (for `^` ties and consecutive rests). */
function lengthParts(ticks: number): string[] | null {
  const parts: string[] = [];
  let rest = ticks;
  while (rest > 0) {
    const entry = LENGTH_TOKENS.find(([t]) => t <= rest);
    if (!entry) return null;
    parts.push(entry[1]);
    rest -= entry[0];
    if (parts.length > 64) return null;
  }
  return parts;
}

function commentText(s: string): string {
  // Keep comments on one line and printable.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function controlToken(c: CanonControl): string {
  switch (c.kind) {
    case 'program':
      return `@${c.program + 1}`;
    case 'cc':
      return `CC(${c.controller},${c.value})`;
    case 'pitchbend':
      return `PB(${c.value})`;
  }
}

class Lines {
  readonly lines: string[] = [];
  private cur: string[] = [];
  add(...tokens: string[]): void {
    this.cur.push(...tokens.filter((t) => t !== ''));
  }
  get empty(): boolean {
    return this.cur.length === 0;
  }
  flush(): void {
    if (this.cur.length > 0) this.lines.push(this.cur.join(' '));
    this.cur = [];
  }
  raw(line: string): void {
    this.flush();
    this.lines.push(line);
  }
}

function channelHeader(out: Lines, ch: CanonChannel, trackNames: Map<number, string>, note?: string): void {
  const n = ch.channel + 1;
  const sources = ch.sourceTracks.map((t) => {
    const name = trackNames.get(t);
    return name ? `MTrk ${t + 1}「${commentText(name)}」` : `MTrk ${t + 1}`;
  });
  out.raw('');
  out.raw(`// CH${n}${n === 10 ? '（GM ドラム）' : ''} ← ${sources.length ? sources.join(', ') : '（イベントなし）'}${note ? ` ${note}` : ''}`);
  out.add(`TR(${n})`, `CH(${n})`);
}

function writeConductor(out: Lines, tempos: CanonTempo[], endTick: number, readable: boolean): void {
  const tokens = (t: CanonTempo) => {
    if (readable) {
      const bpm = 60_000_000 / t.microsecondsPerQuarter;
      const rounded = Math.round(bpm);
      if (rounded >= 20 && rounded <= 300 && Math.round(60_000_000 / rounded) === t.microsecondsPerQuarter) return `Tempo(${rounded})`;
    }
    return `TempoUS(${t.microsecondsPerQuarter})`;
  };
  out.raw('// テンポ（楽曲全体）');
  out.add('TR(0)');
  let cursor = 0;
  for (const t of tempos) {
    if (t.tick !== cursor) {
      out.flush();
      out.add(timeOf(t.tick));
      cursor = t.tick;
    }
    out.add(tokens(t));
  }
  if (endTick > 0) {
    out.flush();
    out.add(timeOf(endTick), '// 曲の終端');
  }
  out.flush();
}

/* ------------------------------------------------------------------ fidelity */

interface Group {
  gate: number;
  velocity: number;
  pitches: number[];
}

function writeFidelityChannel(out: Lines, ch: CanonChannel, trackNames: Map<number, string>, note?: string): void {
  channelHeader(out, ch, trackNames, note);
  writeFidelityBody(out, ch);
}

/**
 * Exact-tick MML for one channel under a given TR number (used by dialect converters when
 * notes of one channel overlap and cannot be written in their original order).
 */
export function exactTicksTrackLines(ch: CanonChannel, trackNumber: number, comment: string): string[] {
  const out = new Lines();
  out.raw('');
  out.raw(comment);
  out.add(`TR(${trackNumber})`, `CH(${ch.channel + 1})`);
  writeFidelityBody(out, ch);
  out.flush();
  return out.lines;
}

function writeFidelityBody(out: Lines, ch: CanonChannel): void {
  const byTick = new Map<number, { controls: CanonControl[]; groups: Map<string, Group> }>();
  const at = (tick: number) => {
    let e = byTick.get(tick);
    if (!e) byTick.set(tick, (e = { controls: [], groups: new Map() }));
    return e;
  };
  for (const c of ch.controls) at(c.tick).controls.push(c);
  for (const n of ch.notes) {
    const gate = n.endTick - n.startTick;
    const key = `${gate}:${n.velocity}`;
    const groups = at(n.startTick).groups;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { gate, velocity: n.velocity, pitches: [] }));
    g.pitches.push(n.pitch);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  let cursor = 0;
  let measure = -1;
  let velocity = 100;
  let gate: number | null = null; // q%N; the initial q90 is never relied upon
  ticks.forEach((tick, i) => {
    const entry = byTick.get(tick)!;
    const m = Math.floor(tick / MEASURE);
    if (cursor !== tick || m !== measure || out.empty) {
      out.flush();
      out.add(timeOf(tick));
      cursor = tick;
      measure = m;
    }
    for (const c of entry.controls) out.add(controlToken(c));
    const groups = [...entry.groups.values()].sort((a, b) => a.gate - b.gate || a.velocity - b.velocity);
    const next = ticks[i + 1];
    groups.forEach((g, j) => {
      const last = j === groups.length - 1;
      const parts: string[] = [];
      if (g.velocity !== velocity) {
        parts.push(`v${g.velocity}`);
        velocity = g.velocity;
      }
      if (g.gate !== gate) {
        parts.push(`q%${g.gate}`);
        gate = g.gate;
      }
      const duration = last && next !== undefined ? next - tick : g.gate;
      const pitches = [...g.pitches].sort((a, b) => a - b);
      const noteText = pitches.length === 1 ? `n${pitches[0]}%${duration}` : `'${pitches.map((p) => `n${p}`).join(' ')}'%${duration}`;
      if (last) {
        out.add(...parts, noteText);
        cursor = tick + duration;
      } else {
        // Same start tick, different gate/velocity: Sub{} restores the cursor exactly.
        out.add(`Sub{ ${[...parts, noteText].join(' ')} }`);
      }
    });
  });
  out.flush();
}

/* ------------------------------------------------------------------ readable */

interface QuantizedChannel {
  channel: CanonChannel;
  collision: boolean;
  notesMoved: number;
  notesResized: number;
  maxStartShift: number;
  maxEndShift: number;
  controlsMoved: number;
}

function quantize(tick: number, grid: number): number {
  return Math.round(tick / grid) * grid;
}

function quantizeChannel(ch: CanonChannel, grid: number): QuantizedChannel {
  let notesMoved = 0;
  let notesResized = 0;
  let maxStartShift = 0;
  let maxEndShift = 0;
  const pairs = ch.notes.map((n) => {
    const start = quantize(n.startTick, grid);
    let end = quantize(n.endTick, grid);
    if (end <= start) end = start + grid;
    return { orig: n, q: { ...n, startTick: start, endTick: end } };
  });
  // Same channel + pitch after quantisation: trim the earlier note; identical start -> collision.
  let collision = false;
  const byPitch = new Map<number, Array<{ q: CanonNote }>>();
  for (const p of pairs) {
    let list = byPitch.get(p.q.pitch);
    if (!list) byPitch.set(p.q.pitch, (list = []));
    list.push(p);
  }
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.q.startTick - b.q.startTick);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1].q;
      const cur = list[i].q;
      if (cur.startTick === prev.startTick) collision = true;
      else if (prev.endTick > cur.startTick) prev.endTick = cur.startTick;
    }
  }
  for (const { orig, q } of pairs) {
    const ds = Math.abs(q.startTick - orig.startTick);
    const de = Math.abs(q.endTick - orig.endTick);
    if (ds > 0) notesMoved++;
    if (q.endTick - q.startTick !== orig.endTick - orig.startTick) notesResized++;
    maxStartShift = Math.max(maxStartShift, ds);
    maxEndShift = Math.max(maxEndShift, de);
  }
  let controlsMoved = 0;
  const controls = ch.controls.map((c) => {
    const tick = quantize(c.tick, grid);
    if (tick !== c.tick) controlsMoved++;
    return { ...c, tick };
  });
  return {
    channel: { ...ch, notes: pairs.map((p) => p.q).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch), controls },
    collision,
    notesMoved,
    notesResized,
    maxStartShift,
    maxEndShift,
    controlsMoved,
  };
}

interface ReadableGroup {
  start: number;
  end: number;
  velocity: number;
  pitches: number[];
}

function writeReadableChannel(out: Lines, ch: CanonChannel, trackNames: Map<number, string>): void {
  channelHeader(out, ch, trackNames);
  out.add('q100');
  out.flush();
  const drum = ch.channel === DRUM_CHANNEL;

  // Controls first (they do not advance time), in original order.
  if (ch.controls.length > 0) {
    out.raw('// 音色・コントローラ');
    let tick = -1;
    for (const c of ch.controls) {
      if (c.tick !== tick) {
        out.flush();
        out.add(timeOf(c.tick));
        tick = c.tick;
      }
      out.add(controlToken(c));
    }
    out.flush();
  }
  if (ch.notes.length === 0) return;

  // Chords: same start, end and velocity.
  const map = new Map<string, ReadableGroup>();
  for (const n of ch.notes) {
    const key = `${n.startTick}:${n.endTick}:${n.velocity}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { start: n.startTick, end: n.endTick, velocity: n.velocity, pitches: [] }));
    g.pitches.push(n.pitch);
  }
  const groups = [...map.values()].sort((a, b) => a.start - b.start || b.end - a.end || Math.min(...a.pitches) - Math.min(...b.pitches));
  // Greedy voice allocation: a voice is a sequence of non-overlapping groups.
  const voices: Array<{ end: number; groups: ReadableGroup[] }> = [];
  for (const g of groups) {
    g.pitches.sort((a, b) => a - b);
    let v = voices.find((x) => x.end <= g.start);
    if (!v) voices.push((v = { end: 0, groups: [] }));
    v.groups.push(g);
    v.end = g.end;
  }

  let octave: number | null = null;
  let velocity = 100;
  let defaultLength: number = PPQ;
  const octaveTokens = (target: number): string => {
    if (octave === target) return '';
    const t = octave !== null && target === octave + 1 ? '>' : octave !== null && target === octave - 1 ? '<' : `o${target} `;
    octave = target;
    return t;
  };
  const named = (p: number) => !drum && p >= 12;

  voices.forEach((voice, vi) => {
    out.raw(vi === 0 ? '// 主声部' : `// 声部 ${vi + 1}（同じチャンネルで重なる音）`);
    // Most frequent single-token length becomes the default `l`.
    const freq = new Map<number, number>();
    for (const g of voice.groups) freq.set(g.end - g.start, (freq.get(g.end - g.start) ?? 0) + 1);
    const common = [...freq.entries()].filter(([t]) => singleToken(t) !== null).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    // Start at the bar line and use rests up to the first note (unless that is far away).
    let cursor = Math.floor(voice.groups[0].start / MEASURE) * MEASURE;
    out.add(timeOf(cursor));
    if (common && common[0] !== defaultLength) {
      out.add(`l${singleToken(common[0])}`);
      defaultLength = common[0];
    }
    let measure = Math.floor(cursor / MEASURE);
    for (const g of voice.groups) {
      const gap = g.start - cursor;
      if (gap >= 2 * MEASURE) {
        out.flush();
        out.add(timeOf(g.start));
        measure = Math.floor(g.start / MEASURE);
      } else if (gap > 0) {
        const parts = lengthParts(gap);
        out.add(parts ? parts.map((p) => `r${p}`).join('') : `r%${gap}`);
      }
      const m = Math.floor(g.start / MEASURE);
      if (m !== measure) {
        out.flush();
        measure = m;
      }
      const tokens: string[] = [];
      if (g.velocity !== velocity) {
        tokens.push(`v${g.velocity}`);
        velocity = g.velocity;
      }
      const len = g.end - g.start;
      const single = singleToken(len);
      if (g.pitches.length === 1 && named(g.pitches[0])) {
        const p = g.pitches[0];
        tokens.push(octaveTokens(Math.floor(p / 12) - 1));
        const parts = lengthParts(len);
        const lengthText = len === defaultLength ? '' : single ?? (parts ? parts.join('^') : `%${len}`);
        tokens.push(NAMES[p % 12] + lengthText);
      } else if (g.pitches.length === 1) {
        // nN takes only the default length or %N (DECISIONS D-007).
        if (len !== defaultLength && single) {
          tokens.push(`l${single}`);
          defaultLength = len;
        }
        tokens.push(len === defaultLength ? `n${g.pitches[0]}` : `n${g.pitches[0]}%${len}`);
      } else {
        const lengthText = len === defaultLength ? '' : single ?? `%${len}`;
        if (g.pitches.every(named)) {
          tokens.push(octaveTokens(Math.floor(g.pitches[0] / 12) - 1));
          let o = octave as number;
          const inner: string[] = [];
          for (const p of g.pitches) {
            const target = Math.floor(p / 12) - 1;
            while (o < target) {
              inner.push('>');
              o++;
            }
            while (o > target) {
              inner.push('<');
              o--;
            }
            inner.push(NAMES[p % 12]);
          }
          tokens.push(`'${inner.join('')}'${lengthText}`);
        } else {
          tokens.push(`'${g.pitches.map((p) => `n${p}`).join(' ')}'${lengthText}`);
        }
      }
      out.add(tokens.filter((t) => t !== '').join(''));
      cursor = g.end;
    }
    out.flush();
  });
}

/* ------------------------------------------------------------------ pipeline */

function header(out: Lines, norm: NormalizedMidi, options: MidiImportOptions): void {
  const s = norm.stats;
  const modeText = options.mode === 'fidelity' ? '忠実度優先' : `読みやすさ優先（量子化 ${options.quantize ?? '1/16'}）`;
  out.raw(`// MML Studio: MIDI から変換（${modeText}）`);
  if (options.fileName) out.raw(`// 元ファイル: ${commentText(options.fileName)}`);
  out.raw(`// SMF Format ${s.originalFormat} / 元 PPQ ${s.originalPpq} → 480 / ${s.sourceTracks} トラック / ${norm.song.channels.length} チャンネル / ${s.noteCount} ノート`);
  out.raw('// Time(M:B:S) は 4/4 固定の座標です（元の拍子とは無関係）。');
}

function finishMml(out: Lines): string {
  out.flush();
  return out.lines.join('\n') + '\n';
}

export interface GeneratedMml {
  mml: string;
  /** Events the MML must reproduce exactly */
  expected: CanonSong;
  quantize?: QuantizeReport;
  warnings: string[];
}

export function generateMml(norm: NormalizedMidi, options: MidiImportOptions): GeneratedMml {
  const out = new Lines();
  const warnings: string[] = [];
  header(out, norm, options);
  if (options.mode === 'fidelity') {
    writeConductor(out, norm.song.tempos, norm.song.endTick, false);
    for (const ch of norm.song.channels) writeFidelityChannel(out, ch, norm.trackNames);
    return { mml: finishMml(out), expected: norm.song, warnings };
  }

  const gridName = options.quantize ?? '1/16';
  const grid = GRID_TICKS[gridName];
  const report: QuantizeReport = { grid, notesMoved: 0, notesResized: 0, maxStartShift: 0, maxEndShift: 0, controlsMoved: 0, temposMoved: 0, fallbackChannels: [] };
  // Tempo: quantised to the grid as well (keeps notes and tempo aligned); last one wins on collisions.
  const tempoMap = new Map<number, number>();
  for (const t of norm.song.tempos) {
    const tick = quantize(t.tick, grid);
    if (tick !== t.tick) report.temposMoved++;
    tempoMap.set(tick, t.microsecondsPerQuarter);
  }
  const tempos = [...tempoMap.entries()].sort((a, b) => a[0] - b[0]).map(([tick, us]) => ({ tick, microsecondsPerQuarter: us }));
  const endTick = Math.max(quantize(norm.song.endTick, grid), norm.song.endTick > 0 ? grid : 0);
  writeConductor(out, tempos, endTick, true);
  const expectedChannels: CanonChannel[] = [];
  for (const ch of norm.song.channels) {
    const q = quantizeChannel(ch, grid);
    if (q.collision) {
      // Quantisation would merge two same-pitch notes: keep exact ticks for this channel.
      report.fallbackChannels.push(ch.channel + 1);
      warnings.push(`CH${ch.channel + 1}: 量子化すると同じ音高のノートが同じ位置に重なるため、このチャンネルは忠実度優先の書式（正確な tick）で出力しました。`);
      writeFidelityChannel(out, ch, norm.trackNames, '（量子化せず正確な tick で出力）');
      expectedChannels.push(ch);
      continue;
    }
    report.notesMoved += q.notesMoved;
    report.notesResized += q.notesResized;
    report.maxStartShift = Math.max(report.maxStartShift, q.maxStartShift);
    report.maxEndShift = Math.max(report.maxEndShift, q.maxEndShift);
    report.controlsMoved += q.controlsMoved;
    writeReadableChannel(out, q.channel, norm.trackNames);
    expectedChannels.push(q.channel);
  }
  if (report.notesMoved || report.notesResized || report.controlsMoved || report.temposMoved) {
    warnings.push(
      `量子化（${gridName} = ${grid} tick）により元の MIDI と差があります: 開始位置の移動 ${report.notesMoved} 音（最大 ${report.maxStartShift} tick）、長さの変更 ${report.notesResized} 音（終了位置の差は最大 ${report.maxEndShift} tick）、コントローラ等の移動 ${report.controlsMoved} 個、テンポの移動 ${report.temposMoved} 個。`,
    );
  }
  return { mml: finishMml(out), expected: { channels: expectedChannels, tempos, endTick }, quantize: report, warnings };
}

function issue(code: string, message: string): ImportIssue {
  return { code, severity: 'error', message };
}

/** Converts a parsed SMF to MML, recompiles it with compileMml and verifies the events. */
export function midiToMml(parsed: ParsedMidi, options: MidiImportOptions, originalSmf: Uint8Array = new Uint8Array(0)): MidiImportResult {
  const norm = normalizeMidi(parsed);
  if (norm.song.endTick > LIMITS.maxTicks) {
    return {
      ok: false,
      originalPlayable: true,
      originalSmf,
      issues: [issue('E_IMPORT_TOO_LONG', `曲が長すぎるため MML に変換できません（${norm.song.endTick} ticks、上限 ${LIMITS.maxTicks} ticks @480PPQ）。元 MIDI の再生は可能です。`)],
    };
  }
  const gen = generateMml(norm, options);
  const bytes = utf8Length(gen.mml);
  if (bytes > LIMITS.maxSourceBytes) {
    return {
      ok: false,
      originalPlayable: true,
      originalSmf,
      issues: [issue('E_IMPORT_TOO_LARGE', `生成した MML が大きすぎます（${bytes} バイト、上限 ${LIMITS.maxSourceBytes} バイト）。元 MIDI の再生は可能です。`)],
    };
  }
  const compiled = compileMml(gen.mml);
  if (!compiled.ok) {
    return {
      ok: false,
      originalPlayable: true,
      originalSmf,
      issues: [
        issue('E_IMPORT_RECOMPILE', '生成した MML の再コンパイルに失敗しました（変換器の不具合です）。元 MIDI の再生は可能です。'),
        ...compiled.diagnostics.slice(0, 10).map((d) => issue(d.code, `${d.span.startLine}行${d.span.startColumn}列: ${d.message}`)),
      ],
    };
  }
  const roundTrip = compareMidiEvents(gen.expected, compiled.song);
  if (!roundTrip.ok) {
    return {
      ok: false,
      originalPlayable: true,
      originalSmf,
      issues: [
        issue('E_IMPORT_VERIFY', `生成した MML を再コンパイルしたイベントが${options.mode === 'fidelity' ? '元 MIDI' : '量子化後の期待値'}と一致しませんでした（${roundTrip.mismatchCount} 件）。この MML は成功扱いにしません。元 MIDI の再生は可能です。`),
        ...roundTrip.mismatches.map((m) => issue('E_IMPORT_VERIFY', m)),
      ],
    };
  }
  const warnings = [...parsed.warnings.map((w) => w.message), ...norm.warnings.map((w) => w.message), ...gen.warnings];
  return {
    ok: true,
    mml: gen.mml,
    originalSmf,
    summary: {
      originalFormat: norm.stats.originalFormat,
      originalPpq: norm.stats.originalPpq,
      sourceTracks: norm.stats.sourceTracks,
      sourceChannels: norm.song.channels.length,
      noteCount: norm.stats.noteCount,
      roundingMaxErrorTicks: norm.stats.roundingMaxErrorTicks,
      warnings,
      mode: options.mode,
      lostEvents: norm.stats.lostEvents,
      roundTrip,
      quantize: gen.quantize,
      mmlBytes: bytes,
      originalDurationSeconds: ticksToSeconds(
        norm.song.endTick,
        norm.song.tempos.map((t) => ({ kind: 'tempo' as const, tick: t.tick, bpm: 60_000_000 / t.microsecondsPerQuarter, microsecondsPerQuarter: t.microsecondsPerQuarter })),
      ),
    },
  };
}

/** readSmf + midiToMml. The original bytes are copied and never modified. */
export function importMidi(bytes: Uint8Array, options: MidiImportOptions, readOptions?: ReadSmfOptions): MidiImportResult {
  const original = bytes.slice();
  const read = readSmf(original, readOptions);
  if (!read.ok) return { ok: false, issues: read.errors, originalPlayable: false };
  return midiToMml(read.midi, options, original);
}
