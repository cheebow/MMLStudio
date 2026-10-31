import { useState } from 'react';
import type { PlaybackState } from '../audio/SoundFontPlaybackAdapter';
import { formatTime } from '../utils/format';

interface Props {
  state: PlaybackState;
  currentTime: number;
  duration: number;
  canPlay: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
}

const STATE_LABEL: Record<PlaybackState, string> = {
  idle: '待機中',
  'loading-soundfont': '音源を読み込み中…',
  compiling: 'コンパイル中…',
  ready: '準備完了',
  playing: '再生中',
  paused: '一時停止中',
  error: 'エラー',
};

export function TransportBar({ state, currentTime, duration, canPlay, onPlay, onPause, onStop, onSeek }: Props) {
  // While dragging, the slider shows the user's value and ignores playback updates.
  const [dragValue, setDragValue] = useState<number | null>(null);
  const busy = state === 'loading-soundfont' || state === 'compiling';
  const seekable = state === 'playing' || state === 'paused';
  const shown = dragValue ?? currentTime;

  const commit = () => {
    if (dragValue !== null) onSeek(dragValue);
    setDragValue(null);
  };

  return (
    <div className="transport" role="group" aria-label="再生コントロール">
      <button
        type="button"
        className="transport-btn primary"
        onClick={onPlay}
        disabled={busy || state === 'playing' || (!canPlay && state !== 'paused')}
        aria-label={state === 'paused' ? '再開' : '再生'}
        title={state === 'paused' ? '再開' : '再生（最新の MML をコンパイル）'}
      >
        ▶ <span>{state === 'paused' ? '再開' : '再生'}</span>
      </button>
      <button type="button" className="transport-btn" onClick={onPause} disabled={state !== 'playing'} aria-label="一時停止">
        ⏸ <span>一時停止</span>
      </button>
      <button type="button" className="transport-btn" onClick={onStop} disabled={!seekable && !busy} aria-label="停止">
        ■ <span>停止</span>
      </button>
      <input
        type="range"
        className="seekbar"
        aria-label="再生位置"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(shown, duration || 0)}
        disabled={!seekable || duration <= 0}
        onChange={(e) => setDragValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="time" aria-live="off">
        {formatTime(shown)} / {formatTime(duration)}
      </span>
      <span className={`state state-${state}`} role="status" data-testid="player-state" data-state={state}>
        {STATE_LABEL[state]}
      </span>
    </div>
  );
}
