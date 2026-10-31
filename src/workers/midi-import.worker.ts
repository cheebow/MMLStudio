// Web Worker: SMF read + MIDI -> MML conversion + recompilation check (SPEC 4.4.1).
// It only calls the pure engine; nothing leaves the browser.
import { importMidi, type MidiImportOptions, type MidiImportResult } from '../engine';

export interface MidiImportRequest {
  id: number;
  bytes: Uint8Array;
  options: MidiImportOptions;
}

export type MidiImportResponse = { id: number; result: MidiImportResult } | { id: number; error: string };

const utf8 = new TextDecoder('utf-8', { fatal: true });
const sjis = (() => {
  try {
    return new TextDecoder('shift_jis', { fatal: true });
  } catch {
    return null;
  }
})();

/** Track names in Japanese MIDI files are often Shift_JIS. */
function decodeText(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    /* fall through */
  }
  if (sjis) {
    try {
      return sjis.decode(bytes);
    } catch {
      /* fall through */
    }
  }
  return [...bytes].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?')).join('');
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<MidiImportRequest>) => void) | null;
  postMessage: (message: MidiImportResponse) => void;
};

scope.onmessage = (e) => {
  const { id, bytes, options } = e.data;
  try {
    const result = importMidi(bytes, options, { decodeText });
    scope.postMessage({ id, result });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
