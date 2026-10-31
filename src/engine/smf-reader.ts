// Hand-written Standard MIDI File reader (SPEC 4.4.1). Format 0/1, PPQ division only.
// Pure TypeScript: no DOM / TextDecoder; text decoding can be injected by the caller.
import { MIDI_LIMITS, type ImportIssue, type MidiReadResult, type ParsedTrack, type RawMidiEvent } from './midi-types';

export interface ReadSmfOptions {
  /** Decoder for meta text (track names etc.). Default: UTF-8 when valid, otherwise ASCII with '?'. */
  decodeText?: (bytes: Uint8Array) => string;
}

class ReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly byteOffset: number,
    readonly track?: number,
  ) {
    super(message);
  }
}

/** Strict UTF-8 decoder (returns null when the bytes are not valid UTF-8). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    let extra: number;
    if (b < 0x80) {
      cp = b;
      extra = 0;
    } else if (b >= 0xc2 && b <= 0xdf) {
      cp = b & 0x1f;
      extra = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      cp = b & 0x0f;
      extra = 2;
    } else if (b >= 0xf0 && b <= 0xf4) {
      cp = b & 0x07;
      extra = 3;
    } else return null;
    for (let k = 1; k <= extra; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((extra === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (extra === 3 && (cp < 0x10000 || cp > 0x10ffff))) return null;
    out += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return out;
}

function defaultDecode(bytes: Uint8Array): string {
  const utf8 = decodeUtf8(bytes);
  if (utf8 !== null) return utf8;
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?';
  return s;
}

const TEXT_META_NAMES: Record<number, string> = {
  0x01: 'テキスト',
  0x02: '著作権表示',
  0x04: '楽器名',
  0x05: '歌詞',
  0x06: 'マーカー',
  0x07: 'キューポイント',
  0x08: 'プログラム名',
  0x09: 'デバイス名',
};

export function metaName(metaType: number): string {
  return TEXT_META_NAMES[metaType] ?? `メタ 0x${metaType.toString(16).padStart(2, '0')}`;
}

interface TrackParse {
  events: RawMidiEvent[];
  /** position after the last parsed byte */
  pos: number;
  sawEot: boolean;
  tick: number;
  eventCount: number;
  noteOnCount: number;
  /** running status was used right after a meta / SysEx event */
  runningAfterMeta: number;
}

/** Strips a MacBinary or RIFF (RMID) container around an SMF. */
function unwrapContainer(bytes: Uint8Array, warnings: ImportIssue[]): Uint8Array {
  const at = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length >= 20 && at(0) === 'RIFF' && at(8) === 'RMID') {
    let p = 12;
    while (p + 8 <= bytes.length) {
      const len = (bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24)) >>> 0;
      if (at(p) === 'data') {
        warnings.push({ code: 'W_MIDI_RMID', severity: 'warning', message: 'RIFF (RMID) 形式の中の SMF を読み込みました。', byteOffset: p });
        return bytes.subarray(p + 8, Math.min(bytes.length, p + 8 + len));
      }
      p += 8 + len + (len & 1);
    }
    return bytes;
  }
  // MacBinary: 128-byte header (byte 0 = 0, byte 1 = file name length 1..63), data fork follows.
  if (bytes.length > 142 && bytes[0] === 0 && bytes[1] >= 1 && bytes[1] <= 63 && at(128) === 'MThd') {
    const forkLength = ((bytes[83] << 24) | (bytes[84] << 16) | (bytes[85] << 8) | bytes[86]) >>> 0;
    warnings.push({ code: 'W_MIDI_MACBINARY', severity: 'warning', message: 'MacBinary 形式のヘッダー（128 バイト）を取り除いて読み込みました。', byteOffset: 0 });
    const endFork = forkLength > 0 && 128 + forkLength <= bytes.length ? 128 + forkLength : bytes.length;
    return bytes.subarray(128, endFork);
  }
  return bytes;
}

export function readSmf(input: Uint8Array, options: ReadSmfOptions = {}): MidiReadResult {
  const decode = options.decodeText ?? defaultDecode;
  if (input.byteLength > MIDI_LIMITS.maxBytes) {
    return fail('E_MIDI_TOO_LARGE', `MIDI ファイルが大きすぎます（${input.byteLength} バイト、上限 ${MIDI_LIMITS.maxBytes / 1024 / 1024} MiB）。`, 0);
  }
  const warnings: ImportIssue[] = [];
  const bytes = unwrapContainer(input, warnings);
  try {
    const ascii = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const u32 = (o: number) => ((bytes[o] << 24) >>> 0) + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3];
    const u16 = (o: number) => (bytes[o] << 8) | bytes[o + 1];

    if (bytes.length < 14 || ascii(0) !== 'MThd') {
      throw new ReadError('E_MIDI_HEADER', 'SMF ではありません（先頭に MThd ヘッダーがありません）。', 0);
    }
    const headerLength = u32(4);
    if (headerLength < 6 || 8 + headerLength > bytes.length) {
      throw new ReadError('E_MIDI_HEADER', `MThd ヘッダー長が不正です（${headerLength}）。`, 4);
    }
    const format = u16(8);
    const ntrks = u16(10);
    const division = u16(12);
    if (format === 2) {
      throw new ReadError('E_MIDI_FORMAT2', 'SMF Format 2（独立した複数シーケンス）は MML 変換に対応していません。', 8);
    }
    if (format !== 0 && format !== 1) {
      throw new ReadError('E_MIDI_FORMAT', `未知の SMF フォーマット ${format} です。`, 8);
    }
    if (division & 0x8000) {
      throw new ReadError('E_MIDI_SMPTE', 'SMPTE 形式の時間単位（タイムコード）の MIDI は MML 変換に対応していません。四分音符単位（PPQ）の MIDI を使ってください。', 12);
    }
    const ppq = division;
    if (ppq === 0) throw new ReadError('E_MIDI_HEADER', 'PPQ（四分音符あたりの tick 数）が 0 です。', 12);
    if (ntrks === 0) throw new ReadError('E_MIDI_HEADER', 'トラック数が 0 です。', 10);
    if (format === 0 && ntrks !== 1) {
      warnings.push({ code: 'W_MIDI_FORMAT0_TRACKS', severity: 'warning', message: `SMF Format 0 なのにトラック数が ${ntrks} です。すべてのトラックを読み込みます。`, byteOffset: 10 });
    }

    let eventCount = 0;
    let noteOnCount = 0;

    /** Parses one MTrk body in [start, limit). Stops after End of Track. */
    const parseTrack = (start: number, limit: number, trackIndex: number): TrackParse => {
      const events: RawMidiEvent[] = [];
      let q = start;
      let tick = 0;
      let running = 0;
      /** last channel status, kept across meta / SysEx for lenient running status */
      let lastChannelStatus = 0;
      let sawEot = false;
      let localEvents = 0;
      let localNoteOns = 0;
      let runningAfterMeta = 0;

      const need = (n: number, what: string) => {
        if (q + n > limit) throw new ReadError('E_MIDI_TRUNCATED_EVENT', `${what} の途中で MTrk が終わっています。`, q, trackIndex);
      };
      const readVlq = (what: string) => {
        const at = q;
        let v = 0;
        for (let k = 0; k < 4; k++) {
          need(1, what);
          const b = bytes[q++];
          v = v * 128 + (b & 0x7f);
          if ((b & 0x80) === 0) return v;
        }
        throw new ReadError('E_MIDI_VLQ', `${what} の可変長数値（VLQ）が4バイトを超えています（破損）。`, at, trackIndex);
      };
      const dataByte = (what: string) => {
        need(1, what);
        const b = bytes[q];
        if (b & 0x80) throw new ReadError('E_MIDI_DATA', `${what} のデータバイトが不正です（0x${b.toString(16)}）。`, q, trackIndex);
        q++;
        return b;
      };

      while (q < limit && !sawEot) {
        if (eventCount + ++localEvents > MIDI_LIMITS.maxEvents) {
          throw new ReadError('E_MIDI_TOO_MANY_EVENTS', `MIDI イベント数が上限（${MIDI_LIMITS.maxEvents}）を超えています。`, q, trackIndex);
        }
        const delta = readVlq('デルタタイム');
        tick += delta;
        need(1, 'イベント');
        const at = q;
        let status = bytes[q];
        if (status & 0x80) {
          q++;
        } else if (running !== 0) {
          status = running;
        } else if (lastChannelStatus !== 0) {
          // Strictly, meta / SysEx cancel running status, but many files keep using it.
          status = lastChannelStatus;
          runningAfterMeta++;
        } else {
          throw new ReadError('E_MIDI_RUNNING_STATUS', 'ランニングステータスの前にステータスバイトがありません（破損）。', q, trackIndex);
        }
        if (status === 0xff) {
          running = 0;
          need(1, 'メタイベント');
          const metaType = bytes[q++];
          const len2 = readVlq('メタイベント長');
          need(len2, 'メタイベント');
          const data = bytes.subarray(q, q + len2);
          q += len2;
          switch (metaType) {
            case 0x2f:
              events.push({ type: 'endOfTrack', tick });
              sawEot = true;
              break;
            case 0x51:
              if (len2 !== 3) throw new ReadError('E_MIDI_META', `テンポイベントの長さが不正です（${len2}）。`, at, trackIndex);
              {
                const us = (data[0] << 16) | (data[1] << 8) | data[2];
                if (us === 0) throw new ReadError('E_MIDI_META', 'テンポ 0 μs/4分音符は不正です。', at, trackIndex);
                events.push({ type: 'tempo', tick, microsecondsPerQuarter: us });
              }
              break;
            case 0x58:
              if (len2 < 2) throw new ReadError('E_MIDI_META', '拍子イベントの長さが不正です。', at, trackIndex);
              events.push({ type: 'timeSignature', tick, numerator: data[0], denominator: 2 ** data[1] });
              break;
            case 0x59:
              events.push({ type: 'keySignature', tick });
              break;
            case 0x03:
              events.push({ type: 'trackName', tick, text: decode(data) });
              break;
            default:
              if (metaType >= 0x01 && metaType <= 0x0f) events.push({ type: 'text', tick, metaType, text: decode(data) });
              else events.push({ type: 'otherMeta', tick, metaType, length: len2 });
          }
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          running = 0;
          const len2 = readVlq('SysEx 長');
          need(len2, 'SysEx');
          q += len2;
          events.push({ type: 'sysex', tick, length: len2 });
          continue;
        }
        if (status >= 0xf1) {
          throw new ReadError('E_MIDI_STATUS', `MTrk 内に使えないステータスバイト 0x${status.toString(16)} があります（破損）。`, at, trackIndex);
        }
        running = status;
        lastChannelStatus = status;
        const kind = status & 0xf0;
        const channel = status & 0x0f;
        switch (kind) {
          case 0x80: {
            const pitch = dataByte('Note Off');
            const velocity = dataByte('Note Off');
            events.push({ type: 'noteOff', tick, channel, pitch, velocity, fromZeroVelocity: false });
            break;
          }
          case 0x90: {
            const pitch = dataByte('Note On');
            const velocity = dataByte('Note On');
            if (velocity === 0) {
              events.push({ type: 'noteOff', tick, channel, pitch, velocity: 0, fromZeroVelocity: true });
            } else {
              if (noteOnCount + ++localNoteOns > MIDI_LIMITS.maxNoteOns) {
                throw new ReadError('E_MIDI_TOO_MANY_NOTES', `Note On 数が上限（${MIDI_LIMITS.maxNoteOns}）を超えています。`, at, trackIndex);
              }
              events.push({ type: 'noteOn', tick, channel, pitch, velocity });
            }
            break;
          }
          case 0xa0: {
            const pitch = dataByte('Polyphonic Aftertouch');
            const value = dataByte('Polyphonic Aftertouch');
            events.push({ type: 'polyPressure', tick, channel, pitch, value });
            break;
          }
          case 0xb0: {
            const controller = dataByte('Control Change');
            const value = dataByte('Control Change');
            events.push({ type: 'cc', tick, channel, controller, value });
            break;
          }
          case 0xc0:
            events.push({ type: 'program', tick, channel, program: dataByte('Program Change') });
            break;
          case 0xd0:
            events.push({ type: 'channelPressure', tick, channel, value: dataByte('Channel Aftertouch') });
            break;
          case 0xe0: {
            const lsb = dataByte('Pitch Bend');
            const msb = dataByte('Pitch Bend');
            events.push({ type: 'pitchbend', tick, channel, value: ((msb << 7) | lsb) - 8192 });
            break;
          }
        }
      }
      return { events, pos: q, sawEot, tick, eventCount: localEvents, noteOnCount: localNoteOns, runningAfterMeta };
    };

    const tracks: ParsedTrack[] = [];
    let p = 8 + headerLength;
    while (tracks.length < ntrks) {
      if (p + 8 > bytes.length) {
        throw new ReadError('E_MIDI_TRUNCATED', `ヘッダーでは ${ntrks} トラックですが、${tracks.length} トラックでファイルが終わっています。`, p);
      }
      const type = ascii(p);
      const len = u32(p + 4);
      const dataStart = p + 8;
      const end = dataStart + len;
      if (type !== 'MTrk') {
        if (end > bytes.length) {
          throw new ReadError('E_MIDI_CHUNK_LENGTH', `チャンク "${printable(type)}" の長さ（${len}）がファイルの残りを超えています。`, p + 4);
        }
        warnings.push({ code: 'W_MIDI_UNKNOWN_CHUNK', severity: 'warning', message: `未知のチャンク "${printable(type)}" を読み飛ばしました。`, byteOffset: p });
        p = end;
        continue;
      }
      const trackIndex = tracks.length;
      /**
       * A wrong MTrk length is recovered only when the track, read up to its End of Track,
       * is immediately followed by the next MTrk header or by the end of the file.
       */
      const recover = (original: ReadError): { parsed: TrackParse; next: number } => {
        let alt: TrackParse;
        try {
          alt = parseTrack(dataStart, bytes.length, trackIndex);
        } catch {
          throw original;
        }
        const followedOk = alt.pos === bytes.length || (alt.pos + 4 <= bytes.length && ascii(alt.pos) === 'MTrk');
        if (!alt.sawEot || !followedOk) throw original;
        warnings.push({
          code: 'W_MIDI_CHUNK_LENGTH_FIXED',
          severity: 'warning',
          message: `MTrk ${trackIndex + 1} のチャンク長（${len}）が実際のデータ（${alt.pos - dataStart} バイト）と合わないため、End of Track までを読み込みました。`,
          track: trackIndex,
          byteOffset: p + 4,
        });
        return { parsed: alt, next: alt.pos };
      };
      let parsed: TrackParse;
      let next: number;
      if (end > bytes.length) {
        ({ parsed, next } = recover(new ReadError('E_MIDI_CHUNK_LENGTH', `チャンク "MTrk" の長さ（${len}）がファイルの残りを超えています。`, p + 4, trackIndex)));
      } else {
        try {
          parsed = parseTrack(dataStart, end, trackIndex);
          next = end;
        } catch (e) {
          if (!(e instanceof ReadError) || e.code !== 'E_MIDI_TRUNCATED_EVENT') throw e;
          ({ parsed, next } = recover(e));
        }
      }
      if (parsed.sawEot && parsed.pos < next) {
        warnings.push({ code: 'W_MIDI_AFTER_EOT', severity: 'warning', message: `MTrk ${trackIndex + 1}: End of Track の後のデータ（${next - parsed.pos} バイト）を無視しました。`, track: trackIndex, byteOffset: parsed.pos });
      }
      if (!parsed.sawEot) {
        warnings.push({ code: 'W_MIDI_NO_EOT', severity: 'warning', message: `MTrk ${trackIndex + 1} に End of Track がありません（チャンク末尾を終端とみなしました）。`, track: trackIndex, byteOffset: next });
      }
      if (parsed.runningAfterMeta > 0) {
        warnings.push({
          code: 'W_MIDI_RUNNING_AFTER_META',
          severity: 'warning',
          message: `MTrk ${trackIndex + 1}: メタイベント／SysEx の後でランニングステータスが使われていました（${parsed.runningAfterMeta} 箇所）。直前のチャンネルステータスとして読み込みました。`,
          track: trackIndex,
        });
      }
      eventCount += parsed.eventCount;
      noteOnCount += parsed.noteOnCount;
      const name = parsed.events.find((e): e is Extract<RawMidiEvent, { type: 'trackName' }> => e.type === 'trackName')?.text;
      tracks.push({ index: trackIndex, name, events: parsed.events, endTick: parsed.tick });
      p = next;
    }
    if (p < bytes.length) {
      warnings.push({ code: 'W_MIDI_TRAILING', severity: 'warning', message: `最後のトラックの後のデータ（${bytes.length - p} バイト）を無視しました。`, byteOffset: p });
    }
    return { ok: true, midi: { format: format as 0 | 1, ppq, tracks, byteLength: input.length, eventCount, noteOnCount, warnings } };
  } catch (e) {
    if (e instanceof ReadError) {
      const where = e.track !== undefined ? `MTrk ${e.track + 1}、` : '';
      return fail(e.code, `${e.message}（${where}バイト位置 ${e.byteOffset}）`, e.byteOffset, e.track);
    }
    throw e;
  }
}

function printable(s: string): string {
  return [...s].map((c) => (c >= ' ' && c <= '~' ? c : '?')).join('');
}

function fail(code: string, message: string, byteOffset: number, track?: number): MidiReadResult {
  return { ok: false, errors: [{ code, severity: 'error', message, byteOffset, track }] };
}
