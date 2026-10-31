// Runs the MIDI import in a dedicated Web Worker (one worker per request; terminated afterwards).
import { importMidi, type MidiImportOptions, type MidiImportResult } from '../engine';
import type { MidiImportRequest, MidiImportResponse } from './midi-import.worker';

export class MidiImportCancelled extends Error {
  constructor() {
    super('MIDI の変換を中止しました。');
  }
}

export interface MidiImportJob {
  promise: Promise<MidiImportResult>;
  cancel: () => void;
}

export interface MidiImportOutcome {
  result: MidiImportResult;
  /** true when the Web Worker could not be used and the conversion ran on the main thread */
  usedFallback: boolean;
}

/** Main-thread fallback (e.g. Workers blocked by CSP / file://). Yields once so the UI can paint. */
async function importOnMainThread(bytes: Uint8Array, options: MidiImportOptions): Promise<MidiImportResult> {
  await new Promise((r) => setTimeout(r, 0));
  const decoder = (() => {
    try {
      return new TextDecoder('shift_jis', { fatal: true });
    } catch {
      return null;
    }
  })();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  return importMidi(bytes, options, {
    decodeText(b) {
      try {
        return utf8.decode(b);
      } catch {
        try {
          if (decoder) return decoder.decode(b);
        } catch {
          /* fall through */
        }
      }
      return [...b].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '?')).join('');
    },
  });
}

/**
 * Runs the import in a Worker; if the Worker cannot start or crashes (not on timeout or cancel),
 * retries once on the main thread.
 */
export function runMidiImportWithFallback(bytes: Uint8Array, options: MidiImportOptions): { promise: Promise<MidiImportOutcome>; cancel: () => void } {
  let cancelled = false;
  const job = runMidiImport(bytes, options);
  const promise = job.promise.then(
    (result) => ({ result, usedFallback: false }),
    async (e: unknown) => {
      // Only when the Worker itself is unusable; a timeout or an engine exception would recur on the main thread.
      if (cancelled || !(e instanceof WorkerFailure) || (e.kind !== 'start' && e.kind !== 'crash')) throw e;
      const result = await importOnMainThread(bytes, options);
      if (cancelled) throw new MidiImportCancelled();
      return { result, usedFallback: true };
    },
  );
  return {
    promise,
    cancel() {
      cancelled = true;
      job.cancel();
    },
  };
}

export class WorkerFailure extends Error {
  constructor(
    readonly kind: 'start' | 'crash' | 'timeout' | 'exception',
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
let nextId = 1;

export function runMidiImport(bytes: Uint8Array, options: MidiImportOptions, timeoutMs = DEFAULT_TIMEOUT_MS): MidiImportJob {
  const id = nextId++;
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectFn: (e: Error) => void = () => undefined;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    worker?.terminate();
    worker = null;
  };
  const promise = new Promise<MidiImportResult>((resolve, reject) => {
    rejectFn = reject;
    try {
      worker = new Worker(new URL('./midi-import.worker.ts', import.meta.url), { type: 'module', name: 'midi-import' });
    } catch (e) {
      reject(new WorkerFailure('start', `変換用の Web Worker を起動できませんでした: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      reject(new WorkerFailure('timeout', `MIDI の変換が ${timeoutMs / 1000} 秒以内に終わらなかったため中止しました。`));
    }, timeoutMs);
    worker.onmessage = (e: MessageEvent<MidiImportResponse>) => {
      if (e.data.id !== id) return;
      cleanup();
      if ('error' in e.data) reject(new WorkerFailure('exception', `MIDI の変換中にエラーが発生しました: ${e.data.error}`));
      else resolve(e.data.result);
    };
    worker.onerror = (e) => {
      cleanup();
      e.preventDefault();
      reject(new WorkerFailure('crash', `MIDI 変換用の Web Worker でエラーが発生しました: ${e.message || '不明なエラー'}`));
    };
    // The worker gets its own copy; the caller's original bytes stay untouched.
    const request: MidiImportRequest = { id, bytes: bytes.slice(), options };
    worker.postMessage(request, [request.bytes.buffer]);
  });
  return {
    promise,
    cancel() {
      if (!worker) return;
      cleanup();
      rejectFn(new MidiImportCancelled());
    },
  };
}
