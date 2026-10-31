// The only module that talks to spessasynth_lib. MML/engine types never leak in here:
// the adapter only receives SMF bytes and SoundFont bytes (SPEC 5.1).
// spessasynth_lib is loaded on demand (first play) to keep the initial bundle small.
import type { Sequencer, WorkletSynthesizer } from 'spessasynth_lib';

/** Minimal structural type of spessasynth's MIDIPatchFull (kept local to the adapter). */
interface MIDIPatchFull {
  program: number;
  bankMSB: number;
  bankLSB: number;
  isGMGSDrum: boolean;
  isDrum: boolean;
  name: string;
}

export interface SoundBankReport {
  presetCount: number;
  /** GM programs (0..127) without a bank-0 melodic preset */
  missingPrograms: number[];
  hasDrumKit: boolean;
}

function gmCoverage(list: readonly MIDIPatchFull[]): SoundBankReport {
  const melodic = new Set(list.filter((p) => !p.isDrum && p.bankMSB === 0).map((p) => p.program));
  const missingPrograms: number[] = [];
  for (let p = 0; p < 128; p++) if (!melodic.has(p)) missingPrograms.push(p);
  return { presetCount: list.length, missingPrograms, hasDrumKit: list.some((p) => p.isDrum) };
}

export type PlaybackState =
  | 'idle'
  | 'loading-soundfont'
  | 'compiling'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'error';

export class PlaybackError extends Error {
  constructor(
    readonly kind: 'audioworklet-unsupported' | 'audiocontext-resume' | 'worklet-load' | 'synth-init' | 'soundfont-load' | 'midi-load',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Rejects with `error` when `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export const TIMEOUTS = { resumeMs: 5000, workletMs: 15000, synthMs: 15000, songMs: 20000 };

interface Engine {
  context: AudioContext;
  synth: WorkletSynthesizer;
  sequencer: Sequencer;
}

export class SoundFontPlaybackAdapter {
  private enginePromise: Promise<Engine> | null = null;
  private engine: Engine | null = null;
  /** Incremented on every song load so stale async completions are ignored. */
  private loadGeneration = 0;
  /** AudioContext created synchronously inside a user gesture (see unlock()). */
  private pendingContext: AudioContext | null = null;
  /** MIDI channels (0..15) the user silenced (mute / solo); re-applied after every song load */
  private silenced: ReadonlySet<number> = new Set();

  constructor(private readonly workletUrl: string) {}

  /**
   * Call synchronously from a click handler: creates / resumes the AudioContext while the
   * user activation is still valid (Safari requires this; SPEC 5.3 step 1).
   */
  unlock(): void {
    if (typeof AudioContext === 'undefined') return;
    const ctx = this.engine?.context ?? this.pendingContext ?? (this.pendingContext = new AudioContext());
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  }

  /** Must be called from a user gesture. Concurrent calls share one promise. */
  ensureEngine(): Promise<Engine> {
    if (!this.enginePromise) {
      this.enginePromise = this.createEngine().catch((e: unknown) => {
        this.enginePromise = null;
        throw e;
      });
    }
    return this.enginePromise;
  }

  private async createEngine(): Promise<Engine> {
    if (typeof AudioWorkletNode === 'undefined') {
      throw new PlaybackError('audioworklet-unsupported', 'このブラウザは AudioWorklet に対応していません。');
    }
    const context = this.pendingContext ?? new AudioContext();
    this.pendingContext = null;
    const fail = async (error: PlaybackError): Promise<never> => {
      await context.close().catch(() => undefined);
      throw error;
    };
    try {
      // Without a user gesture resume() may never settle; do not hang forever.
      await withTimeout(context.resume(), TIMEOUTS.resumeMs, () => new Error('timeout'));
    } catch (cause) {
      return fail(
        new PlaybackError('audiocontext-resume', 'ブラウザが音声の再生を開始できませんでした（自動再生の制限）。もう一度「再生」ボタンを押してください。', { cause }),
      );
    }
    let lib: typeof import('spessasynth_lib');
    try {
      [lib] = await Promise.all([
        import('spessasynth_lib'),
        withTimeout(context.audioWorklet.addModule(this.workletUrl), TIMEOUTS.workletMs, () => new Error('timeout')),
      ]);
    } catch (cause) {
      return fail(new PlaybackError('worklet-load', `AudioWorklet (${this.workletUrl}) を読み込めませんでした。ページを再読み込みしてください。`, { cause }));
    }
    const synth = new lib.WorkletSynthesizer(context);
    synth.connect(context.destination);
    try {
      await withTimeout(synth.isReady, TIMEOUTS.synthMs, () => new Error('timeout'));
    } catch (cause) {
      synth.destroy();
      return fail(new PlaybackError('synth-init', 'シンセサイザーを初期化できませんでした。ページを再読み込みしてください。', { cause }));
    }
    const sequencer = new lib.Sequencer(synth, { skipToFirstNoteOn: false });
    this.engine = { context, synth, sequencer };
    // channels added for multi-port MIDI start unmuted
    synth.eventHandler.addEvent('channelAdded', 'mml-studio-mute', () => this.applyMutes());
    this.applyMutes();
    return this.engine;
  }

  /**
   * Replaces the main sound bank. The ArrayBuffer is transferred (detached) to the worklet.
   * Resolves with a GM coverage report once the preset list has been updated.
   */
  async loadSoundBank(buffer: ArrayBuffer): Promise<SoundBankReport> {
    const { synth, sequencer } = await this.ensureEngine();
    sequencer.pause();
    synth.stopAll(true);
    const presets = new Promise<MIDIPatchFull[]>((resolve) => {
      const timer = setTimeout(() => resolve(synth.presetList), 3000);
      synth.eventHandler.addEvent('presetListChange', 'mml-studio-bank', (list) => {
        clearTimeout(timer);
        resolve(list);
      });
    });
    try {
      await synth.soundBankManager.addSoundBank(buffer, 'main');
    } catch (cause) {
      throw new PlaybackError('soundfont-load', 'SoundFont を読み込めませんでした（SF2 として不正な可能性があります）。', { cause });
    }
    return gmCoverage(await presets);
  }

  /** Loads SMF bytes into the sequencer and resolves when the song is ready (songChange). */
  async loadSmf(smf: Uint8Array, fileName: string): Promise<{ duration: number } | null> {
    const generation = ++this.loadGeneration;
    const { synth, sequencer } = await this.ensureEngine();
    sequencer.pause();
    synth.stopAll(true);
    // Copy exactly the data range into a fresh ArrayBuffer (SPEC 5.3 step 5).
    const binary = smf.slice().buffer;
    const done = new Promise<void>((resolve, reject) => {
      sequencer.eventHandler.addEvent('songChange', 'mml-studio-load', () => resolve());
      sequencer.eventHandler.addEvent('midiError', 'mml-studio-load', (e) =>
        reject(new PlaybackError('midi-load', `MIDI を読み込めませんでした: ${e.message}`, { cause: e })),
      );
    });
    sequencer.loopCount = 0;
    sequencer.loadNewSongList([{ binary, fileName }]);
    await withTimeout(done, TIMEOUTS.songMs, () => new PlaybackError('midi-load', 'MIDI の読み込みが時間内に終わりませんでした。'));
    if (generation !== this.loadGeneration) return null;
    this.applyMutes();
    return { duration: sequencer.duration };
  }

  /** Silences MIDI channels (mute / solo). Channels of other ports (16+) follow channel % 16. */
  setSilencedChannels(channels: readonly number[]): void {
    this.silenced = new Set(channels);
    this.applyMutes();
  }

  private applyMutes(): void {
    if (!this.engine) return;
    this.engine.synth.midiChannels.forEach((ch, i) => {
      const muted = this.silenced.has(i % 16);
      if (ch.systemParameters.isMuted !== muted) ch.setSystemParameter('isMuted', muted);
    });
  }

  play(): void {
    this.engine?.sequencer.play();
  }

  pause(): void {
    this.engine?.sequencer.pause();
  }

  stop(): void {
    if (!this.engine) return;
    const { sequencer, synth } = this.engine;
    sequencer.pause();
    sequencer.currentTime = 0;
    synth.stopAll(true);
  }

  seek(seconds: number): void {
    if (!this.engine) return;
    this.engine.sequencer.currentTime = Math.max(0, seconds);
  }

  get currentTime(): number {
    return this.engine?.sequencer.currentHighResolutionTime ?? 0;
  }

  get duration(): number {
    return this.engine?.sequencer.duration ?? 0;
  }

  get isPaused(): boolean {
    return this.engine?.sequencer.paused ?? true;
  }

  get isFinished(): boolean {
    return this.engine?.sequencer.isFinished ?? false;
  }

  /** true when audio can start without a fresh user gesture (the context is already running) */
  get isUnlocked(): boolean {
    return this.engine?.context.state === 'running';
  }

  get audioContextState(): AudioContextState | 'none' {
    return this.engine?.context.state ?? 'none';
  }

  async destroy(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.enginePromise = null;
    if (!engine) return;
    engine.sequencer.pause();
    engine.synth.stopAll(true);
    engine.synth.destroy();
    await engine.context.close();
  }
}
