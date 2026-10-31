import { useMemo, useState, type MouseEvent } from 'react';
import type { SourceSpan } from '../engine';
import { ChannelMonitor } from './ChannelMonitor';
import { MAX_PPS, MIN_PPS, PianoRoll } from './PianoRoll';
import type { Mix } from './mix';
import type { RollData } from './roll-data';
import { TrackRail } from './TrackRail';

type View = 'roll' | 'channels';

interface Props {
  data: RollData | null;
  time: number;
  playing: boolean;
  canSeek: boolean;
  onSeek(seconds: number): void;
  onJump(span: SourceSpan): void;
  /** what is shown (MML / original MIDI) */
  sourceLabel: string;
  /** mute / solo of the audio (by track label) */
  mix: Mix;
  onToggleMute(label: string): void;
  onToggleSolo(label: string): void;
  /** closes the panel; omitted in player mode (the panel is always shown) */
  onClose?: () => void;
}

function readView(): View {
  try {
    return localStorage.getItem('mmlstudio.viz.view') === 'channels' ? 'channels' : 'roll';
  } catch {
    return 'roll';
  }
}

/**
 * The playback view below the editor (SPEC 6.3): piano roll or channel monitor, with the track column
 * at the left that shows / hides tracks (display only) and mutes / solos them (audio, SPEC 6.4).
 */
export function PlaybackPanel({ data, time, playing, canSeek, onSeek, onJump, sourceLabel, mix, onToggleMute, onToggleSolo, onClose }: Props) {
  const [view, setView] = useState<View>(readView);
  const [pps, setPps] = useState(80);
  /** hidden tracks by label, so the choice survives recompiles */
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlySet<string>>(new Set());
  const labels = useMemo(() => data?.tracks.map((t) => t.label) ?? [], [data]);
  const hidden = useMemo(() => new Set(labels.flatMap((l, i) => (hiddenLabels.has(l) ? [i] : []))), [labels, hiddenLabels]);

  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('mmlstudio.viz.view', v);
    } catch {
      /* ignore */
    }
  };
  const toggle = (e: MouseEvent, label: string) => {
    setHiddenLabels((prev) => {
      if (e.shiftKey) {
        // solo; Shift+click on the only visible track shows all again
        const solo = labels.every((l) => (l === label) !== prev.has(l));
        return solo ? new Set() : new Set(labels.filter((l) => l !== label));
      }
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };
  const rail = (
    <TrackRail tracks={data?.tracks ?? []} hidden={hidden} mix={mix} onToggleShow={toggle} onToggleMute={onToggleMute} onToggleSolo={onToggleSolo} />
  );
  const zoom = (factor: number) => setPps((v) => Math.min(MAX_PPS, Math.max(MIN_PPS, v * factor)));

  return (
    <div className="roll">
      <div className="roll-bar">
        {onClose && (
          <button type="button" className="link-btn roll-toggle" aria-expanded="true" aria-label="演奏表示を閉じる" title="演奏表示を閉じる" onClick={onClose}>
            ▾
          </button>
        )}
        <span className="viz-tabs" role="tablist" aria-label="表示の種類">
          <button type="button" role="tab" aria-selected={view === 'roll'} className="viz-tab" onClick={() => choose('roll')}>
            ピアノロール
          </button>
          <button type="button" role="tab" aria-selected={view === 'channels'} className="viz-tab" onClick={() => choose('channels')}>
            チャンネル
          </button>
        </span>
        <span className="muted small">{sourceLabel}</span>
        <span className="roll-spacer" />
        {view === 'roll' && (
          <span className="roll-zoom">
            <button type="button" className="small-btn" aria-label="縮小" title="縮小（Ctrl＋ホイール / -）" onClick={() => zoom(1 / 1.25)}>
              −
            </button>
            <button type="button" className="small-btn" aria-label="拡大" title="拡大（Ctrl＋ホイール / +）" onClick={() => zoom(1.25)}>
              ＋
            </button>
          </span>
        )}
      </div>
      {view === 'roll' ? (
        <div className="viz-body">
          <div className="rail-scroll">{rail}</div>
          <PianoRoll data={data} time={time} playing={playing} canSeek={canSeek} onSeek={onSeek} onJump={onJump} hidden={hidden} pps={pps} onZoom={zoom} />
        </div>
      ) : (
        <ChannelMonitor data={data} time={time} hidden={hidden} rail={rail} />
      )}
    </div>
  );
}
