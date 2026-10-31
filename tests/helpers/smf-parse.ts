// Independent, test-only SMF parser used to verify writeSmf output.
// Deliberately separate from (and simpler than) src/engine/smf-reader.ts.

export interface TestMidiEvent {
  tick: number;
  type: 'noteOn' | 'noteOff' | 'program' | 'cc' | 'pitchbend' | 'tempo' | 'timeSig' | 'eot' | 'meta' | 'other';
  channel?: number;
  data: number[];
}

export interface TestMidi {
  format: number;
  ntrks: number;
  division: number;
  tracks: TestMidiEvent[][];
}

export function parseSmfForTest(bytes: Uint8Array): TestMidi {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (str(0) !== 'MThd') throw new Error('no MThd');
  if (dv.getUint32(4) !== 6) throw new Error('bad header length');
  const format = dv.getUint16(8);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  let p = 14;
  const tracks: TestMidiEvent[][] = [];
  for (let t = 0; t < ntrks; t++) {
    if (str(p) !== 'MTrk') throw new Error(`no MTrk at ${p}`);
    const len = dv.getUint32(p + 4);
    const end = p + 8 + len;
    p += 8;
    const events: TestMidiEvent[] = [];
    let tick = 0;
    let running = 0;
    const vlq = () => {
      let v = 0;
      for (let k = 0; k < 4; k++) {
        const b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) return v;
      }
      throw new Error('VLQ too long');
    };
    while (p < end) {
      tick += vlq();
      let status = bytes[p];
      if (status & 0x80) p++;
      else status = running;
      if (status === 0xff) {
        const type = bytes[p++];
        const l = vlq();
        const data = [...bytes.subarray(p, p + l)];
        p += l;
        events.push({
          tick,
          type: type === 0x51 ? 'tempo' : type === 0x58 ? 'timeSig' : type === 0x2f ? 'eot' : 'meta',
          data,
        });
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const l = vlq();
        p += l;
        events.push({ tick, type: 'other', data: [] });
        continue;
      }
      running = status;
      const hi = status & 0xf0;
      const channel = status & 0x0f;
      const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
      const data = [...bytes.subarray(p, p + n)];
      p += n;
      const type =
        hi === 0x90 ? (data[1] === 0 ? 'noteOff' : 'noteOn') : hi === 0x80 ? 'noteOff' : hi === 0xc0 ? 'program' : hi === 0xb0 ? 'cc' : hi === 0xe0 ? 'pitchbend' : 'other';
      events.push({ tick, type, channel, data });
    }
    if (p !== end) throw new Error(`track ${t} overran its chunk`);
    tracks.push(events);
  }
  if (p !== bytes.length) throw new Error('trailing bytes');
  return { format, ntrks, division, tracks };
}
