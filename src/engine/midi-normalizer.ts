// ParsedMidi -> per-channel canonical events at 480 PPQ (SPEC 4.4.1, 4.4.2).
import { metaName } from './smf-reader';
import type { CanonChannel, CanonControl, CanonNote, CanonTempo, ImportIssue, NormalizedMidi, ParsedMidi, RawMidiEvent } from './midi-types';
import { PPQ } from './types';

const DRUM_CHANNEL = 9;

interface Ordered {
  ev: RawMidiEvent;
  track: number;
  seq: number;
}

interface OpenNote {
  channel: number;
  pitch: number;
  velocity: number;
  start: number; // original ticks
  end: number | null;
}

/** Rounds an original tick to 480 PPQ (half up) and reports the error in 480-PPQ ticks. */
export function makeTickConverter(ppq: number): { convert: (tick: number) => number; maxError: () => number } {
  let maxError = 0;
  return {
    convert(tick: number) {
      const scaled = tick * PPQ;
      const whole = Math.floor(scaled / ppq);
      const rem = scaled - whole * ppq;
      const rounded = rem * 2 >= ppq ? whole + 1 : whole;
      const err = Math.abs(scaled / ppq - rounded);
      if (err > maxError) maxError = err;
      return rounded;
    },
    maxError: () => maxError,
  };
}

export function normalizeMidi(midi: ParsedMidi): NormalizedMidi {
  const warnings: ImportIssue[] = [];
  const lost: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const count = (key: string, n = 1) => (counters[key] = (counters[key] ?? 0) + n);
  const lose = (label: string, n = 1) => (lost[label] = (lost[label] ?? 0) + n);
  const trackNames = new Map<number, string>();

  // 1. Merge all MTrks into one stream: (tick, MTrk index, file order). Deterministic.
  const stream: Ordered[] = [];
  for (const t of midi.tracks) {
    t.events.forEach((ev, seq) => stream.push({ ev, track: t.index, seq }));
    if (t.name !== undefined && t.name.trim() !== '') trackNames.set(t.index, t.name);
  }
  stream.sort((a, b) => a.ev.tick - b.ev.tick || a.track - b.track || a.seq - b.seq);

  const songEndOriginal = midi.tracks.reduce((m, t) => Math.max(m, t.endTick), 0);
  const conv = makeTickConverter(midi.ppq);

  const open = new Map<number, OpenNote>();
  /** Note Offs still owed to notes that were force-closed by an overlapping Note On (FIFO pairing). */
  const credits = new Map<number, number>();
  const finished: OpenNote[] = [];
  const controls = new Map<number, Array<{ c: CanonControl; seq: number }>>();
  const channelTracks = new Map<number, Set<number>>();
  const tempoByTick = new Map<number, number>();
  let seqCounter = 0;

  const touch = (channel: number, track: number) => {
    let s = channelTracks.get(channel);
    if (!s) channelTracks.set(channel, (s = new Set()));
    s.add(track);
  };
  const addControl = (channel: number, c: CanonControl) => {
    let list = controls.get(channel);
    if (!list) controls.set(channel, (list = []));
    list.push({ c, seq: seqCounter++ });
  };

  for (const { ev, track } of stream) {
    switch (ev.type) {
      case 'noteOn': {
        touch(ev.channel, track);
        const key = ev.channel * 128 + ev.pitch;
        const prev = open.get(key);
        if (prev) {
          // Ambiguous overlap of the same channel + pitch: shorten the previous note (SPEC 3.4 / 4.4.2).
          prev.end = ev.tick;
          finished.push(prev);
          credits.set(key, (credits.get(key) ?? 0) + 1);
          count('overlap');
        }
        open.set(key, { channel: ev.channel, pitch: ev.pitch, velocity: ev.velocity, start: ev.tick, end: null });
        break;
      }
      case 'noteOff': {
        const key = ev.channel * 128 + ev.pitch;
        const owed = credits.get(key) ?? 0;
        if (owed > 0) {
          credits.set(key, owed - 1);
          break;
        }
        const n = open.get(key);
        if (n) {
          n.end = ev.tick;
          finished.push(n);
          open.delete(key);
        } else {
          count('orphanOff');
        }
        break;
      }
      case 'cc':
        touch(ev.channel, track);
        if (ev.controller === 0 || ev.controller === 32) count('bankSelect');
        addControl(ev.channel, { kind: 'cc', channel: ev.channel, tick: ev.tick, controller: ev.controller, value: ev.value });
        break;
      case 'program':
        touch(ev.channel, track);
        if (ev.channel === DRUM_CHANNEL) {
          lose('ドラム（CH10）の Program Change（キット変更）');
          break;
        }
        addControl(ev.channel, { kind: 'program', channel: ev.channel, tick: ev.tick, program: ev.program });
        break;
      case 'pitchbend':
        touch(ev.channel, track);
        addControl(ev.channel, { kind: 'pitchbend', channel: ev.channel, tick: ev.tick, value: ev.value });
        break;
      case 'channelPressure':
        lose('チャンネルアフタータッチ');
        break;
      case 'polyPressure':
        lose('ポリフォニックアフタータッチ');
        break;
      case 'tempo': {
        const tick = conv.convert(ev.tick);
        const prev = tempoByTick.get(tick);
        if (prev !== undefined && prev !== ev.microsecondsPerQuarter) count('tempoConflict');
        tempoByTick.set(tick, ev.microsecondsPerQuarter); // last one wins
        break;
      }
      case 'timeSignature':
        // MML Studio always writes 4/4 at tick 0; anything else is lost.
        if (!(ev.tick === 0 && ev.numerator === 4 && ev.denominator === 4)) lose('拍子（Time Signature）');
        break;
      case 'keySignature':
        lose('調号（Key Signature）');
        break;
      case 'trackName':
        break; // kept as a comment in the MML
      case 'text':
        lose(metaName(ev.metaType));
        break;
      case 'otherMeta':
        lose(metaName(ev.metaType));
        break;
      case 'sysex':
        lose('SysEx');
        break;
      case 'endOfTrack':
        break;
    }
  }

  // Unterminated notes end at the song end.
  for (const n of open.values()) {
    n.end = Math.max(songEndOriginal, n.start);
    finished.push(n);
    count('unterminated');
  }

  // 2. Convert note times to 480 PPQ (each event rounded individually).
  const byKey = new Map<number, CanonNote[]>();
  for (const n of finished) {
    const startTick = conv.convert(n.start);
    let endTick = conv.convert(n.end ?? n.start);
    if (endTick <= startTick) {
      endTick = startTick + 1;
      count('minLength');
    }
    const note: CanonNote = { channel: n.channel, pitch: n.pitch, velocity: n.velocity, startTick, endTick };
    const key = n.channel * 128 + n.pitch;
    let list = byKey.get(key);
    if (!list) byKey.set(key, (list = []));
    list.push(note);
  }

  // 3. Resolve same channel + pitch collisions created by rounding / 1-tick correction.
  const notesByChannel = new Map<number, CanonNote[]>();
  for (const list of byKey.values()) {
    list.sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
    const kept: CanonNote[] = [];
    for (const n of list) {
      const prev = kept[kept.length - 1];
      if (prev && prev.startTick === n.startTick) {
        count('merged');
        prev.endTick = Math.max(prev.endTick, n.endTick);
        continue;
      }
      if (prev && prev.endTick > n.startTick) {
        prev.endTick = n.startTick;
        count('trimmed');
      }
      kept.push(n);
    }
    for (const n of kept) {
      let arr = notesByChannel.get(n.channel);
      if (!arr) notesByChannel.set(n.channel, (arr = []));
      arr.push(n);
    }
  }

  const channelsUsed = new Set<number>([...notesByChannel.keys(), ...controls.keys()]);
  const channels: CanonChannel[] = [...channelsUsed]
    .sort((a, b) => a - b)
    .map((channel) => ({
      channel,
      notes: (notesByChannel.get(channel) ?? []).sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch),
      controls: (controls.get(channel) ?? []).map(({ c }) => ({ ...c, tick: conv.convert(c.tick) })),
      sourceTracks: [...(channelTracks.get(channel) ?? [])].sort((a, b) => a - b),
    }));

  const tempos: CanonTempo[] = [...tempoByTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, us]) => ({ tick, microsecondsPerQuarter: us }));

  let endTick = conv.convert(songEndOriginal);
  for (const ch of channels) {
    for (const n of ch.notes) endTick = Math.max(endTick, n.endTick);
    for (const c of ch.controls) endTick = Math.max(endTick, c.tick);
  }
  for (const t of tempos) endTick = Math.max(endTick, t.tick);

  const noteCount = channels.reduce((s, c) => s + c.notes.length, 0);
  const w = (code: string, message: string) => warnings.push({ code, severity: 'warning', message });
  if (counters.overlap) w('W_IMPORT_OVERLAP', `同じチャンネル・同じ音高のノートが重なっていました（${counters.overlap} 箇所）。前の音を次の音の直前で終わらせています。元 MIDI の直接再生には影響しません。`);
  if (counters.orphanOff) w('W_IMPORT_ORPHAN_OFF', `対応する Note On のない Note Off を ${counters.orphanOff} 個無視しました。`);
  if (counters.unterminated) w('W_IMPORT_UNTERMINATED', `Note Off のないノートが ${counters.unterminated} 個あり、曲の終端で終了させました。`);
  if (counters.minLength) w('W_IMPORT_MIN_LENGTH', `長さ 0 になるノートが ${counters.minLength} 個あり、最短 1 tick に補正しました。`);
  if (counters.trimmed) w('W_IMPORT_TRIMMED', `480 PPQ への丸めで次の同音と重なったノート ${counters.trimmed} 個の終了を早めました。`);
  if (counters.merged) w('W_IMPORT_MERGED', `480 PPQ への丸めで同じ tick に重なった同音 ${counters.merged} 個を統合しました。`);
  if (counters.tempoConflict) w('W_IMPORT_TEMPO_CONFLICT', `同じ tick に異なるテンポが ${counters.tempoConflict} 箇所あり、トラック順・イベント順で最後のものを採用しました。`);
  if (counters.bankSelect) w('W_IMPORT_BANK', `バンクセレクト（CC0 / CC32）が ${counters.bankSelect} 個あります。そのまま書き出しますが、音色は SoundFont に依存します。`);
  for (const [label, n] of Object.entries(lost)) {
    w('W_IMPORT_LOST', `MML に変換できないイベント: ${label} × ${n}（元 MIDI の直接再生では保持されます）`);
  }

  return {
    song: { channels, tempos, endTick },
    stats: {
      originalFormat: midi.format,
      originalPpq: midi.ppq,
      sourceTracks: midi.tracks.length,
      noteCount,
      roundingMaxErrorTicks: Math.round(conv.maxError() * 1000) / 1000,
      lostEvents: lost,
    },
    trackNames,
    warnings,
  };
}
