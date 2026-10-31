// Playback state machine around SoundFontPlaybackAdapter (SPEC 5.3 / 5.4).
// Scheduling is entirely done by the SpessaSynth Sequencer; the rAF loop only updates the UI.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlaybackError, SoundFontPlaybackAdapter, type PlaybackState, type SoundBankReport } from '../audio/SoundFontPlaybackAdapter';
import { DEFAULT_SOUNDFONT_URL, WORKLET_URL, fetchSoundFont } from '../audio/SoundFontLoader';

export interface SongToPlay {
  smf: Uint8Array;
  fileName: string;
}

export type SoundFontChoice = { kind: 'default' } | { kind: 'local'; name: string; file: File };

export interface SoundFontInfo {
  kind: 'default' | 'local';
  name: string;
  status: 'not-loaded' | 'loading' | 'loaded' | 'error';
  progress: number | null;
  report?: SoundBankReport;
  error?: string;
}

export interface Player {
  state: PlaybackState;
  error: string | null;
  soundFont: SoundFontInfo;
  currentTime: number;
  duration: number;
  /** Starts playback of a freshly prepared song, or resumes when paused. */
  play: (prepare: () => SongToPlay | null) => Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (seconds: number) => void;
  /** Silences MIDI channels 0..15 (mute / solo). Applies immediately and to later songs. */
  setSilencedChannels: (channels: readonly number[]) => void;
  /** true when playback can start without a user gesture (audio already unlocked by an earlier play) */
  canStartWithoutGesture: () => boolean;
  /** Must be called from a user gesture (file picker / click). */
  selectSoundFont: (choice: SoundFontChoice) => Promise<void>;
}

export const DEFAULT_SOUNDFONT_NAME = 'GeneralUser GS v2.0.3（標準）';
const MAX_SF2_BYTES = 512 * 1024 * 1024;

class Cancelled extends Error {}

function describe(e: unknown): string {
  if (e instanceof PlaybackError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function usePlayer(): Player {
  const adapterRef = useRef<SoundFontPlaybackAdapter | null>(null);
  /** Promise of the currently selected sound bank being loaded (null: nothing requested yet). */
  const soundFontRef = useRef<Promise<void> | null>(null);
  const choiceRef = useRef<SoundFontChoice>({ kind: 'default' });
  const soundFontGen = useRef(0);
  const requestRef = useRef(0);
  const [state, setState] = useState<PlaybackState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [soundFont, setSoundFont] = useState<SoundFontInfo>({ kind: 'default', name: DEFAULT_SOUNDFONT_NAME, status: 'not-loaded', progress: null });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const adapter = useCallback(() => {
    adapterRef.current ??= new SoundFontPlaybackAdapter(WORKLET_URL);
    return adapterRef.current;
  }, []);

  /** Starts loading `choice`; loads are serialised so the latest selection always wins. */
  const startSoundFontLoad = useCallback(
    (choice: SoundFontChoice) => {
      const gen = ++soundFontGen.current;
      choiceRef.current = choice;
      const name = choice.kind === 'default' ? DEFAULT_SOUNDFONT_NAME : choice.name;
      const previous = soundFontRef.current ?? Promise.resolve();
      const check = () => {
        if (gen !== soundFontGen.current) throw new Cancelled();
      };
      const promise = previous
        .catch(() => undefined)
        .then(async () => {
          check();
          setSoundFont({ kind: choice.kind, name, status: 'loading', progress: choice.kind === 'default' ? 0 : null });
          const a = adapter();
          await a.ensureEngine();
          check();
          let buffer: ArrayBuffer;
          if (choice.kind === 'default') {
            buffer = await fetchSoundFont(DEFAULT_SOUNDFONT_URL, (p) => {
              if (gen === soundFontGen.current) setSoundFont((s) => ({ ...s, progress: p }));
            });
          } else {
            if (choice.file.size > MAX_SF2_BYTES) throw new Error(`SF2 ファイルが大きすぎます（上限 ${MAX_SF2_BYTES / 1024 / 1024} MiB）。`);
            buffer = await choice.file.arrayBuffer();
          }
          check();
          const report = await a.loadSoundBank(buffer);
          check();
          setSoundFont({ kind: choice.kind, name, status: 'loaded', progress: 1, report });
        });
      const tracked = promise.catch((e: unknown) => {
        if (e instanceof Cancelled) return;
        if (gen === soundFontGen.current) {
          setSoundFont({ kind: choice.kind, name, status: 'error', progress: null, error: describe(e) });
          soundFontRef.current = null; // allow retry
        }
        throw e;
      });
      soundFontRef.current = tracked;
      return tracked;
    },
    [adapter],
  );

  const ensureSoundFont = useCallback(async () => {
    // Wait until the *latest* selection has loaded (a newer selection may start meanwhile).
    for (;;) {
      const p = soundFontRef.current ?? startSoundFontLoad(choiceRef.current);
      await p;
      if (soundFontRef.current === p) return;
    }
  }, [startSoundFontLoad]);

  const play = useCallback(
    async (prepare: () => SongToPlay | null) => {
      const a = adapter();
      a.unlock(); // synchronously inside the click (user activation)
      if (state === 'paused') {
        a.play();
        setState('playing');
        return;
      }
      if (state === 'loading-soundfont' || state === 'compiling' || state === 'playing') return;
      const id = ++requestRef.current;
      setError(null);
      try {
        setState('loading-soundfont');
        await ensureSoundFont();
        if (id !== requestRef.current) return;
        setState('compiling');
        const song = prepare();
        if (!song) {
          setState('ready');
          return;
        }
        const loaded = await a.loadSmf(song.smf, song.fileName);
        if (!loaded || id !== requestRef.current) return;
        setDuration(loaded.duration);
        setCurrentTime(0);
        a.play();
        setState('playing');
      } catch (e) {
        if (id !== requestRef.current) return;
        console.error(e);
        setError(describe(e));
        setState('error');
      }
    },
    [adapter, ensureSoundFont, state],
  );

  const pause = useCallback(() => {
    if (state !== 'playing') return;
    adapterRef.current?.pause();
    setState('paused');
  }, [state]);

  const stop = useCallback(() => {
    requestRef.current++; // cancel any in-flight load
    adapterRef.current?.stop();
    setCurrentTime(0);
    setState((s) => (s === 'idle' ? s : 'ready'));
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      if (state !== 'playing' && state !== 'paused') return;
      const clamped = Math.min(Math.max(0, seconds), duration);
      adapterRef.current?.seek(clamped);
      setCurrentTime(clamped);
    },
    [state, duration],
  );

  const selectSoundFont = useCallback(
    async (choice: SoundFontChoice) => {
      // Switching sound banks stops playback first (SPEC 5.3).
      adapter().unlock();
      requestRef.current++;
      adapterRef.current?.stop();
      setCurrentTime(0);
      setError(null);
      setState('loading-soundfont');
      try {
        await startSoundFontLoad(choice);
        setState('ready');
      } catch (e) {
        if (e instanceof Cancelled) return;
        setError(describe(e));
        setState('error');
      }
    },
    [adapter, startSoundFontLoad],
  );

  const setSilencedChannels = useCallback((channels: readonly number[]) => adapter().setSilencedChannels(channels), [adapter]);
  const canStartWithoutGesture = useCallback(() => adapterRef.current?.isUnlocked ?? false, []);

  // UI-only clock: reads the sequencer time; never schedules notes.
  useEffect(() => {
    if (state !== 'playing') return;
    let raf = 0;
    const tick = () => {
      const a = adapterRef.current;
      if (!a) return;
      if (a.isFinished) {
        setCurrentTime(0);
        setState('ready');
        return;
      }
      setCurrentTime(Math.min(a.currentTime, a.duration));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  useEffect(() => {
    return () => {
      void adapterRef.current?.destroy();
      adapterRef.current = null;
      soundFontRef.current = null;
    };
  }, []);

  return { state, error, soundFont, currentTime, duration, play, pause, stop, seek, setSilencedChannels, canStartWithoutGesture, selectSoundFont };
}
