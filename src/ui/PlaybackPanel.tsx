import { useMemo, useState, type MouseEvent } from 'react';
import type { SourceSpan } from '../engine';
import { ChannelMonitor } from './ChannelMonitor';
import { MAX_PPS, MIN_PPS, PianoRoll } from './PianoRoll';
import type { RollData } from './roll-data';
import { laneColor, prefersDark } from './viz-colors';

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
  onClose(): void;
}

function readView(): View {
  try {
    return localStorage.getItem('mmlstudio.viz.view') === 'channels' ? 'channels' : 'roll';
  } catch {
    return 'roll';
  }
}

/**
 * The playback view below the editor (SPEC 6.3): piano roll or channel monitor, with a legend
 * whose buttons show / hide tracks. Display only; the audio is not changed.
 */
export function PlaybackPanel({ data, time, playing, canSeek, onSeek, onJump, sourceLabel, onClose }: Props) {
  const [view, setView] = useState<View>(readView);
  const [pps, setPps] = useState(80);
  /** hidden tracks by label, so the choice survives recompiles */
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlySet<string>>(new Set());
  const labels = useMemo(() => data?.tracks.map((t) => t.label) ?? [], [data]);
  const hidden = useMemo(() => new Set(labels.flatMap((l, i) => (hiddenLabels.has(l) ? [i] : []))), [labels, hiddenLabels]);
  const dark = prefersDark();

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
  const zoom = (factor: number) => setPps((v) => Math.min(MAX_PPS, Math.max(MIN_PPS, v * factor)));

  return (
    <div className="roll">
      <div className="roll-bar">
        <button type="button" className="link-btn roll-toggle" aria-expanded="true" aria-label="演奏表示を閉じる" title="演奏表示を閉じる" onClick={onClose}>
          ▾
        </button>
        <span className="viz-tabs" role="tablist" aria-label="表示の種類">
          <button type="button" role="tab" aria-selected={view === 'roll'} className="viz-tab" onClick={() => choose('roll')}>
            ピアノロール
          </button>
          <button type="button" role="tab" aria-selected={view === 'channels'} className="viz-tab" onClick={() => choose('channels')}>
            チャンネル
          </button>
        </span>
        <span className="muted small">{sourceLabel}</span>
        <span className="roll-legend" role="group" aria-label="トラックの表示（クリックで表示・非表示、Shift＋クリックでそのトラックだけ表示）">
          {data?.tracks.map((t, i) => (
            <button
              key={`${t.label}-${i}`}
              type="button"
              className="roll-chip"
              aria-pressed={!hidden.has(i)}
              title={`${t.label} の表示を切り替え（Shift＋クリックでこのトラックだけ表示）`}
              onClick={(e) => toggle(e, t.label)}
            >
              <span className="roll-swatch" style={{ background: laneColor(i, t.drum, dark) }} />
              {t.label}
            </button>
          ))}
        </span>
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
        <PianoRoll data={data} time={time} playing={playing} canSeek={canSeek} onSeek={onSeek} onJump={onJump} hidden={hidden} pps={pps} onZoom={zoom} />
      ) : (
        <ChannelMonitor data={data} time={time} hidden={hidden} />
      )}
    </div>
  );
}
