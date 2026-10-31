import type { MouseEvent } from 'react';
import { isSilenced, type Mix } from './mix';
import type { RollTrack } from './roll-data';
import { laneColor, prefersDark } from './viz-colors';

/** row geometry shared with the channel monitor so the rows line up (SPEC 6.3 / 6.4) */
export const RAIL_HEAD_H = 18;
export const RAIL_ROW_H = 22;

interface Props {
  tracks: readonly RollTrack[];
  /** lanes not drawn */
  hidden: ReadonlySet<number>;
  mix: Mix;
  onToggleShow(e: MouseEvent, label: string): void;
  onToggleMute(label: string): void;
  onToggleSolo(label: string): void;
}

/**
 * The track column at the left of the playback view: per track, show / hide (display only) and
 * mute / solo (audio). The same column is used by the piano roll and the channel monitor.
 */
export function TrackRail({ tracks, hidden, mix, onToggleShow, onToggleMute, onToggleSolo }: Props) {
  const dark = prefersDark();
  return (
    <div className="track-rail" role="group" aria-label="トラック（名前か色のバーのクリックで表示・非表示、Shift＋クリックでそのトラックだけ表示。M でミュート、S でソロ）">
      <div className="rail-head" style={{ height: RAIL_HEAD_H }} aria-hidden="true">
        トラック
      </div>
      {tracks.length === 0 && <div className="rail-empty muted small">—</div>}
      {tracks.map((t, i) => {
        const shown = !hidden.has(i);
        return (
          <div
            key={`${t.label}-${i}`}
            className={`rail-row${shown ? '' : ' off'}${isSilenced(mix, t.label) ? ' silenced' : ''}`}
            style={{ height: RAIL_ROW_H }}
            data-track={t.label}
          >
            <button
              type="button"
              className="rail-show"
              aria-pressed={shown}
              aria-label={`${t.label} を表示`}
              title={`${t.label} の表示・非表示（Shift＋クリックでこのトラックだけ表示）`}
              onClick={(e) => onToggleShow(e, t.label)}
            >
              <span className="rail-bar" style={{ background: laneColor(i, t.drum, dark) }} />
              <span className="rail-label">{t.label}</span>
            </button>
            <button
              type="button"
              className="rail-btn mute"
              aria-pressed={mix.muted.has(t.label)}
              aria-label={`${t.label} をミュート`}
              title={`${t.label} の音を消す（もう一度で戻す）`}
              onClick={() => onToggleMute(t.label)}
            >
              M
            </button>
            <button
              type="button"
              className="rail-btn solo"
              aria-pressed={mix.soloed.has(t.label)}
              aria-label={`${t.label} をソロ`}
              title={`${t.label} をソロ（ソロのトラックだけ鳴らす。複数選べます）`}
              onClick={() => onToggleSolo(t.label)}
            >
              S
            </button>
          </div>
        );
      })}
    </div>
  );
}
