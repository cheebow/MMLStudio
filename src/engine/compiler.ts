// Semantic compiler: commands -> per-track state -> IR (SPEC 3, 4.1). Pure and deterministic.
import { parse, type Command, type LengthSpec, type PitchSpec } from './parser';
import { error, SourceMap, utf8Length } from './source';
import { tokenize } from './tokenizer';
import {
  LIMITS,
  PPQ,
  type CompileResult,
  type CompiledTrack,
  type Diagnostic,
  type NoteEvent,
  type SourceSpan,
  type TempoEvent,
  type TrackEvent,
} from './types';

const SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const WHOLE = PPQ * 4;
export const DEFAULT_BPM = 120;
export const DEFAULT_US_PER_QUARTER = 500_000;

interface TrackState {
  number: number;
  /** 1-based MIDI channel, null when not yet assigned (TR16..32) */
  channel: number | null;
  channelSpan: SourceSpan | null;
  /** set once any channel event has been emitted; CH can no longer change */
  channelLocked: boolean;
  firstEventSpan: SourceSpan | null;
  octave: number;
  defaultLength: number;
  velocity: number;
  gate: { mode: 'percent' | 'ticks'; value: number };
  cursorTick: number;
  /** furthest cursor position ever reached (Time / Sub can move backwards) */
  maxCursor: number;
  events: TrackEvent[];
}

interface PendingTempo {
  tick: number;
  bpm: number;
  us: number;
  span: SourceSpan;
}

/** Initial channel for a track number (SPEC 3.5). */
export function defaultChannelFor(track: number): number | null {
  if (track >= 1 && track <= 9) return track;
  if (track >= 10 && track <= 15) return track + 1;
  return null;
}

export function lengthToTicks(spec: LengthSpec): number {
  if (spec.kind === 'ticks') return spec.ticks;
  const base = WHOLE / spec.denom;
  return spec.dotted ? base * 1.5 : base;
}

class Abort extends Error {}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  private readonly tracks = new Map<number, TrackState>();
  private readonly tempos: PendingTempo[] = [];
  private current: TrackState;
  private conductorCursor = 0;
  private conductorMax = 0;
  private currentNumber = 1;
  private noteCount = 0;

  constructor() {
    this.current = this.track(1);
  }

  private err(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push(error(code, message, span));
  }

  private track(n: number): TrackState {
    let t = this.tracks.get(n);
    if (!t) {
      t = {
        number: n,
        channel: defaultChannelFor(n),
        channelSpan: null,
        channelLocked: false,
        firstEventSpan: null,
        octave: 4,
        defaultLength: PPQ,
        velocity: 100,
        gate: { mode: 'percent', value: 90 },
        cursorTick: 0,
        maxCursor: 0,
        events: [],
      };
      this.tracks.set(n, t);
    }
    return t;
  }

  run(commands: Command[]): void {
    try {
      for (const c of commands) this.command(c);
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
    }
  }

  private isConductor(): boolean {
    return this.currentNumber === 0;
  }

  private command(c: Command): void {
    if (c.kind === 'track') {
      this.currentNumber = c.n;
      if (c.n !== 0) this.current = this.track(c.n);
      return;
    }
    if (c.kind === 'tempo' || c.kind === 'tempoUs') {
      const tick = this.isConductor() ? this.conductorCursor : this.current.cursorTick;
      const us = c.kind === 'tempo' ? Math.round(60_000_000 / c.bpm) : c.us;
      const bpm = c.kind === 'tempo' ? c.bpm : 60_000_000 / c.us;
      this.tempos.push({ tick, bpm, us, span: c.span });
      return;
    }
    if (c.kind === 'time') {
      const tick = ((c.measure - 1) * 4 + (c.beat - 1)) * PPQ + c.tick;
      if (tick > LIMITS.maxTicks) {
        this.err('E_LIMIT', `Time の位置（tick ${tick}）が曲長の上限（${LIMITS.maxTicks} ticks）を超えています。`, c.span);
        throw new Abort();
      }
      if (this.isConductor()) {
        this.conductorCursor = tick;
        this.conductorMax = Math.max(this.conductorMax, tick);
      } else {
        this.current.cursorTick = tick;
        this.current.maxCursor = Math.max(this.current.maxCursor, tick);
      }
      return;
    }
    if (this.isConductor()) {
      this.err('E_CONDUCTOR', 'TR(0) はテンポ専用のコンダクタートラックです（使えるのは Tempo / t / TempoUS / Time のみ）。音符・休符・音色・CH などは TR(1) 以降に書いてください。', c.span);
      return;
    }
    const t = this.current;
    switch (c.kind) {
      case 'channel':
        if (t.channelLocked) {
          this.err('E_CHANNEL_LOCKED', `CH は TR(${t.number}) の最初の演奏イベントより前にのみ指定できます。`, c.span);
          return;
        }
        t.channel = c.n;
        t.channelSpan = c.span;
        return;
      case 'octave':
        t.octave = c.n;
        return;
      case 'octaveShift': {
        const o = this.shiftOctave(t.octave, c.delta, c.span);
        if (o !== null) t.octave = o;
        return;
      }
      case 'defaultLength':
        t.defaultLength = lengthToTicks(c.length);
        return;
      case 'velocity':
        t.velocity = c.n;
        return;
      case 'gate':
        t.gate = { mode: c.mode, value: c.value };
        return;
      case 'program': {
        const ch = this.requireChannel(t, c.span);
        if (ch === null) return;
        if (ch === 10) {
          this.err('E_DRUM_PROGRAM', 'ドラムチャンネル CH(10) では @ による音色指定はできません（キット変更は将来対応）。', c.span);
          return;
        }
        t.events.push({ kind: 'program', track: t.number, channel: ch - 1, tick: t.cursorTick, program: c.n - 1, source: c.span });
        return;
      }
      case 'cc': {
        const ch = this.requireChannel(t, c.span);
        if (ch === null) return;
        t.events.push({ kind: 'cc', track: t.number, channel: ch - 1, tick: t.cursorTick, controller: c.controller, value: c.value, source: c.span });
        return;
      }
      case 'pitchbend': {
        const ch = this.requireChannel(t, c.span);
        if (ch === null) return;
        t.events.push({ kind: 'pitchbend', track: t.number, channel: ch - 1, tick: t.cursorTick, value: c.value, source: c.span });
        return;
      }
      case 'rest':
        this.advance(t, c.length ? lengthToTicks(c.length) : t.defaultLength, c.span);
        return;
      case 'note':
        return this.note(t, c);
      case 'chord':
        return this.chord(t, c);
      case 'sub': {
        // Only the cursor is restored; octave / l / v / q / program changes persist (SPEC 3.7).
        const start = t.cursorTick;
        for (const inner of c.body) this.command(inner);
        t.cursorTick = start;
        return;
      }
    }
  }

  private shiftOctave(octave: number, delta: 1 | -1, span: SourceSpan): number | null {
    const o = octave + delta;
    if (o < 0 || o > 9) {
      this.err('E_RANGE', `オクターブが範囲外になります（0〜9、現在 o${octave}）。`, span);
      return null;
    }
    return o;
  }

  private gateFor(t: TrackState, duration: number): number {
    if (t.gate.mode === 'ticks') return t.gate.value;
    let gate = Math.round((duration * t.gate.value) / 100);
    if (t.gate.value > 0 && gate < 1) gate = 1;
    return gate;
  }

  private emitNote(t: TrackState, ch: number, pitch: number, duration: number, gate: number, span: SourceSpan): void {
    if (gate <= 0 || t.velocity <= 0) return;
    if (++this.noteCount > LIMITS.maxNotes) {
      this.err('E_LIMIT', `音符数が上限（${LIMITS.maxNotes}）を超えました。`, span);
      throw new Abort();
    }
    if (t.cursorTick + gate > LIMITS.maxTicks) {
      this.err('E_LIMIT', `発音の終了位置が曲長の上限（${LIMITS.maxTicks} ticks）を超えています。`, span);
      throw new Abort();
    }
    t.events.push({
      kind: 'note',
      track: t.number,
      channel: ch - 1,
      pitch,
      velocity: t.velocity,
      startTick: t.cursorTick,
      durationTicks: duration,
      gateTicks: gate,
      source: span,
    });
  }

  private chord(t: TrackState, c: Extract<Command, { kind: 'chord' }>): void {
    // `<` `>` are only temporary inside the chord (SPEC 3.7).
    let octave = t.octave;
    const pitches: number[] = [];
    let ok = true;
    for (const item of c.items) {
      if (item.kind === 'shift') {
        const o = this.shiftOctave(octave, item.delta, item.span);
        if (o === null) {
          ok = false;
          break;
        }
        octave = o;
        continue;
      }
      const p = this.pitchAt(octave, item.pitch);
      if (p === null) {
        ok = false;
        continue;
      }
      if (pitches.includes(p)) {
        this.err('E_CHORD', `和音の中で同じ音高（${p}）が重複しています。`, item.pitch.span);
        ok = false;
        continue;
      }
      pitches.push(p);
    }
    const duration = c.length ? lengthToTicks(c.length) : t.defaultLength;
    const ch = this.requireChannel(t, c.span);
    if (ok && ch !== null) {
      const gate = this.gateFor(t, duration);
      for (const p of pitches) this.emitNote(t, ch, p, duration, gate, c.span);
    }
    this.advance(t, duration, c.span);
  }
  private requireChannel(t: TrackState, span: SourceSpan): number | null {
    if (t.channel === null) {
      this.err('E_CHANNEL_REQUIRED', `TR(${t.number}) にはチャンネルの自動割当がありません。最初の演奏イベントより前に CH(1〜16) を指定してください。`, span);
      return null;
    }
    if (!t.channelLocked) {
      t.channelLocked = true;
      t.firstEventSpan = span;
    }
    return t.channel;
  }

  private pitchOf(t: TrackState, p: PitchSpec): number | null {
    return this.pitchAt(t.octave, p);
  }

  private pitchAt(octave: number, p: PitchSpec): number | null {
    if (p.kind === 'abs') return p.pitch;
    const pitch = 12 * (octave + 1) + SEMITONES[p.letter] + p.accidental;
    if (pitch < 0 || pitch > 127) {
      this.err('E_PITCH_RANGE', `音高が MIDI の範囲（0〜127）を超えています（o${octave} で ${pitch}）。`, p.span);
      return null;
    }
    return pitch;
  }

  private note(t: TrackState, c: Extract<Command, { kind: 'note' }>): void {
    const pitch = this.pitchOf(t, c.pitch);
    let duration = (c.length ? lengthToTicks(c.length) : t.defaultLength) + c.adds.reduce((s, a) => s + lengthToTicks(a), 0);
    let ok = pitch !== null;
    for (const tie of c.ties) {
      const p = this.pitchOf(t, tie.pitch);
      if (p === null) {
        ok = false;
      } else if (pitch !== null && p !== pitch) {
        this.err('E_TIE_PITCH', '& でつなげるのは同じ音高の音符だけです（異なる音高のスラーは未対応）。', tie.span);
        ok = false;
      }
      duration += (tie.length ? lengthToTicks(tie.length) : t.defaultLength) + tie.adds.reduce((s, a) => s + lengthToTicks(a), 0);
    }
    const ch = this.requireChannel(t, c.span);
    if (ok && ch !== null && pitch !== null) this.emitNote(t, ch, pitch, duration, this.gateFor(t, duration), c.span);
    this.advance(t, duration, c.span);
  }

  private advance(t: TrackState, ticks: number, span: SourceSpan): void {
    t.cursorTick += ticks;
    t.maxCursor = Math.max(t.maxCursor, t.cursorTick);
    if (t.cursorTick > LIMITS.maxTicks) {
      this.err('E_LIMIT', `曲長が上限（${LIMITS.maxTicks} ticks）を超えました。`, span);
      throw new Abort();
    }
  }

  finish(): { tracks: CompiledTrack[]; tempoMap: TempoEvent[]; endTick: number } {
    const used = [...this.tracks.values()]
      .filter((t) => t.events.length > 0 || t.channelSpan !== null)
      .sort((a, b) => a.number - b.number);

    // Channel sharing between performance tracks is forbidden (SPEC 3.5).
    const owner = new Map<number, number>();
    for (const t of used) {
      if (t.channel === null) continue;
      const prev = owner.get(t.channel);
      if (prev !== undefined) {
        const span = t.channelSpan ?? t.firstEventSpan ?? t.events[0]?.source;
        if (span) this.err('E_CHANNEL_CONFLICT', `CH(${t.channel}) は TR(${prev}) と TR(${t.number}) で共有されています。トラックごとに別のチャンネルを使ってください。`, span);
      } else {
        owner.set(t.channel, t.number);
      }
    }

    const tracks: CompiledTrack[] = used
      .filter((t) => t.events.length > 0 && t.channel !== null)
      .map((t) => ({
        number: t.number,
        channel: (t.channel as number) - 1,
        events: stableSortByTick(t.events),
      }));

    this.checkOverlaps(tracks);
    const tempoMap = this.buildTempoMap();

    let endTick = this.conductorMax;
    for (const t of this.tracks.values()) endTick = Math.max(endTick, t.maxCursor);
    for (const t of tracks) {
      for (const e of t.events) {
        endTick = Math.max(endTick, e.kind === 'note' ? e.startTick + Math.max(e.durationTicks, e.gateTicks) : e.tick);
      }
    }
    for (const tm of tempoMap) endTick = Math.max(endTick, tm.tick);
    return { tracks, tempoMap, endTick };
  }

  /** Same channel + pitch must not sound at the same time (DECISIONS D-004). */
  private checkOverlaps(tracks: CompiledTrack[]): void {
    const groups = new Map<number, NoteEvent[]>();
    for (const t of tracks) {
      for (const e of t.events) {
        if (e.kind !== 'note' || e.gateTicks <= 0) continue;
        const key = e.channel * 128 + e.pitch;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(e);
      }
    }
    for (const notes of groups.values()) {
      notes.sort((a, b) => a.startTick - b.startTick || a.source.startOffset - b.source.startOffset);
      let end = -1;
      for (const n of notes) {
        if (n.startTick < end) {
          this.err('E_OVERLAP', `同じチャンネル・同じ音高（${n.pitch}）のノートが時間的に重なっています（tick ${n.startTick}）。`, n.source);
        }
        end = Math.max(end, n.startTick + n.gateTicks);
      }
    }
  }

  private buildTempoMap(): TempoEvent[] {
    const byTick = new Map<number, PendingTempo>();
    const sorted = [...this.tempos].sort((a, b) => a.tick - b.tick || a.span.startOffset - b.span.startOffset);
    for (const t of sorted) {
      const prev = byTick.get(t.tick);
      if (!prev) {
        byTick.set(t.tick, t);
      } else if (prev.us !== t.us) {
        this.err('E_TEMPO_CONFLICT', `tick ${t.tick} で異なるテンポ（${describeTempo(prev)} と ${describeTempo(t)}）が指定されています。テンポは楽曲全体で共通です。`, t.span);
      }
    }
    const map: TempoEvent[] = [...byTick.values()].map((t) => ({
      kind: 'tempo',
      tick: t.tick,
      bpm: t.bpm,
      microsecondsPerQuarter: t.us,
      source: t.span,
    }));
    if (!byTick.has(0)) {
      map.unshift({ kind: 'tempo', tick: 0, bpm: DEFAULT_BPM, microsecondsPerQuarter: DEFAULT_US_PER_QUARTER });
    }
    return map;
  }
}

function describeTempo(t: PendingTempo): string {
  return Number.isInteger(t.bpm) ? `${t.bpm} BPM` : `${t.us} μs/4分音符`;
}

function eventTick(e: TrackEvent): number {
  return e.kind === 'note' ? e.startTick : e.tick;
}

function stableSortByTick(events: TrackEvent[]): TrackEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => eventTick(a.e) - eventTick(b.e) || a.i - b.i)
    .map((x) => x.e);
}

export function compileMml(source: string): CompileResult {
  const map = new SourceMap(source);
  const bytes = utf8Length(source);
  if (bytes > LIMITS.maxSourceBytes) {
    return {
      ok: false,
      diagnostics: [error('E_LIMIT', `MML が大きすぎます（${bytes} バイト、上限 ${LIMITS.maxSourceBytes} バイト）。`, map.span(0, 0))],
    };
  }
  const lex = tokenize(source, map);
  const parsed = parse(lex.tokens);
  const syntax = [...lex.diagnostics, ...parsed.diagnostics];
  if (syntax.length > 0) {
    return { ok: false, diagnostics: limitDiagnostics(sortDiagnostics(syntax)) };
  }
  const compiler = new Compiler();
  compiler.run(parsed.commands);
  const { tracks, tempoMap, endTick } = compiler.finish();
  const errors = compiler.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return { ok: false, diagnostics: limitDiagnostics(sortDiagnostics(compiler.diagnostics)) };
  }
  const warnings = sortDiagnostics(compiler.diagnostics);
  return { ok: true, song: { ppq: PPQ, tracks, tempoMap, endTick, diagnostics: warnings }, diagnostics: warnings };
}

function sortDiagnostics(d: Diagnostic[]): Diagnostic[] {
  return [...d].sort((a, b) => a.span.startOffset - b.span.startOffset);
}

function limitDiagnostics(d: Diagnostic[]): Diagnostic[] {
  return d.length > LIMITS.maxDiagnostics ? d.slice(0, LIMITS.maxDiagnostics) : d;
}
