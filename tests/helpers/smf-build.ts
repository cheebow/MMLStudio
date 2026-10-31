// Test-only raw SMF builder. Writes exactly the bytes given (running status, Note On velocity 0,
// long VLQs etc. are under the test's control). Independent of src/engine/smf-writer.ts.

export function vlq(n: number): number[] {
  const out = [n & 0x7f];
  let v = Math.floor(n / 128);
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  return out;
}

/** An event: delta time and raw bytes (status may be omitted for running status). */
export type Ev = [delta: number, ...bytes: number[]];

export const on = (d: number, ch: number, p: number, v = 100): Ev => [d, 0x90 | ch, p, v];
export const off = (d: number, ch: number, p: number, v = 64): Ev => [d, 0x80 | ch, p, v];
export const cc = (d: number, ch: number, c: number, v: number): Ev => [d, 0xb0 | ch, c, v];
export const program = (d: number, ch: number, p: number): Ev => [d, 0xc0 | ch, p];
export const bend = (d: number, ch: number, value: number): Ev => {
  const v = value + 8192;
  return [d, 0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f];
};
export const tempo = (d: number, us: number): Ev => [d, 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
export const meta = (d: number, type: number, data: number[]): Ev => [d, 0xff, type, ...vlq(data.length), ...data];
export const text = (d: number, type: number, s: string): Ev => meta(d, type, [...new TextEncoder().encode(s)]);
export const eot = (d = 0): Ev => [d, 0xff, 0x2f, 0x00];

export function trackBytes(events: Ev[], { addEot = true } = {}): number[] {
  const data: number[] = [];
  for (const [d, ...bytes] of events) data.push(...vlq(d), ...bytes);
  if (addEot) data.push(...vlq(0), 0xff, 0x2f, 0x00);
  return chunk('MTrk', data);
}

export function chunk(type: string, data: number[]): number[] {
  const n = data.length;
  return [...[...type].map((c) => c.charCodeAt(0)), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...data];
}

export function smf(format: number, division: number, tracks: number[][], ntrks = tracks.length): Uint8Array {
  const header = chunk('MThd', [0, format, (ntrks >> 8) & 0xff, ntrks & 0xff, (division >> 8) & 0xff, division & 0xff]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

/** Convenience: one track from events. */
export const build = (format: number, ppq: number, ...tracks: Ev[][]) => smf(format, ppq, tracks.map((t) => trackBytes(t)));
