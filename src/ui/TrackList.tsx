import { DRUM_CHANNEL_INDEX, instrumentName } from '../audio/instrument-names';
import type { CompiledSong } from '../engine';
import { trackVoice } from './track-voice';

interface Props {
  song: CompiledSong | null;
  stale: boolean;
}

/** Display only: never edits the MML source (SPEC 6.1). */
export function TrackList({ song, stale }: Props) {
  return (
    <section className="panel tracks" aria-labelledby="tracks-title">
      <h2 id="tracks-title">
        トラック {stale && <span className="muted small">（最後に成功したコンパイル結果）</span>}
      </h2>
      {!song || song.tracks.length === 0 ? (
        <p className="muted">演奏トラックはまだありません。</p>
      ) : (
        <table className="track-table">
          <thead>
            <tr>
              <th scope="col">TR</th>
              <th scope="col">CH</th>
              <th scope="col">音色</th>
              <th scope="col">音符数</th>
            </tr>
          </thead>
          <tbody>
            {song.tracks.map((t) => {
              const notes = t.events.filter((e) => e.kind === 'note').length;
              const isDrum = t.channel === DRUM_CHANNEL_INDEX;
              const voice = trackVoice(t.events);
              const name = isDrum ? 'GM ドラム' : `@${voice.program + 1} ${instrumentName(voice.program)}`;
              const extra = isDrum ? 0 : voice.changes;
              return (
                <tr key={t.number}>
                  <td>{t.number}</td>
                  <td>{t.channel + 1}</td>
                  <td>
                    {name}
                    {extra > 0 && <span className="muted small">（途中変更 {extra} 回）</span>}
                  </td>
                  <td>{notes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
