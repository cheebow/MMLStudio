// Hand-written Standard MIDI File (Type 1, PPQ 480) writer (SPEC 4.2).
import { PPQ, type CompiledSong, type CompiledTrack } from './types';

const DRUM_CHANNEL = 9;

/** Order of events at the same tick: meta, Note Off, CC/PB/Program (source order), Note On. */
const enum Order {
  Meta = 0,
  NoteOff = 1,
  Control = 2,
  NoteOn = 3,
}

interface RawEvent {
  tick: number;
  order: Order;
  seq: number;
  bytes: number[];
}

export function encodeVlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError(`VLQ value out of range: ${value}`);
  }
  const out = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return out;
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [
    ...[...type].map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...data,
  ];
}

function serializeTrack(events: RawEvent[], endTick: number): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.seq - b.seq);
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...encodeVlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(...encodeVlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
  return chunk('MTrk', data);
}

function conductorTrack(song: CompiledSong): number[] {
  const events: RawEvent[] = [];
  let seq = 0;
  // Initial time signature 4/4, 24 MIDI clocks per beat, 8 32nd notes per quarter.
  events.push({ tick: 0, order: Order.Meta, seq: seq++, bytes: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] });
  for (const t of song.tempoMap) {
    const us = t.microsecondsPerQuarter;
    events.push({ tick: t.tick, order: Order.Meta, seq: seq++, bytes: [0xff, 0x51, 0x03, (us >>> 16) & 0xff, (us >>> 8) & 0xff, us & 0xff] });
  }
  return serializeTrack(events, song.endTick);
}

function performanceTrack(track: CompiledTrack, endTick: number): number[] {
  const events: RawEvent[] = [];
  let seq = 0;
  const ch = track.channel & 0x0f;
  const hasProgramAtZero = track.events.some((e) => e.kind === 'program' && e.tick === 0);
  if (ch !== DRUM_CHANNEL && !hasProgramAtZero) {
    events.push({ tick: 0, order: Order.Control, seq: seq++, bytes: [0xc0 | ch, 0] });
  }
  for (const e of track.events) {
    switch (e.kind) {
      case 'note':
        events.push({ tick: e.startTick, order: Order.NoteOn, seq: seq++, bytes: [0x90 | ch, e.pitch, e.velocity] });
        events.push({ tick: e.startTick + e.gateTicks, order: Order.NoteOff, seq: seq++, bytes: [0x80 | ch, e.pitch, 0] });
        break;
      case 'program':
        events.push({ tick: e.tick, order: Order.Control, seq: seq++, bytes: [0xc0 | ch, e.program & 0x7f] });
        break;
      case 'cc':
        events.push({ tick: e.tick, order: Order.Control, seq: seq++, bytes: [0xb0 | ch, e.controller & 0x7f, e.value & 0x7f] });
        break;
      case 'pitchbend': {
        const v = e.value + 8192;
        events.push({ tick: e.tick, order: Order.Control, seq: seq++, bytes: [0xe0 | ch, v & 0x7f, (v >>> 7) & 0x7f] });
        break;
      }
    }
  }
  return serializeTrack(events, endTick);
}

export function writeSmf(song: CompiledSong): Uint8Array {
  const tracks = [conductorTrack(song), ...song.tracks.map((t) => performanceTrack(t, song.endTick))];
  const header = chunk('MThd', [0x00, 0x01, (tracks.length >>> 8) & 0xff, tracks.length & 0xff, (PPQ >>> 8) & 0xff, PPQ & 0xff]);
  const total = header.length + tracks.reduce((s, t) => s + t.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of [header, ...tracks]) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
