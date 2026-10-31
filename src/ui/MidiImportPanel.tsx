import { useState } from 'react';
import type { ImportIssue, MidiImportOptions, MidiImportSummary, QuantizeGrid } from '../engine';
import { formatTime } from '../utils/format';

export type PlaySource = 'mml' | 'original';

export interface MidiDocument {
  fileName: string;
  /** Original SMF bytes. Never modified; playback always receives a copy. */
  bytes: Uint8Array;
  options: MidiImportOptions;
  summary: MidiImportSummary | null;
  /** errors of the last conversion (MML not generated) */
  issues: ImportIssue[];
  /** MML text produced by the last successful conversion */
  generatedMml: string | null;
}

interface Props {
  doc: MidiDocument;
  source: PlaySource;
  busy: boolean;
  canRestoreBackup: boolean;
  onSourceChange: (s: PlaySource) => void;
  onReconvert: (options: MidiImportOptions) => void;
  onRestoreBackup: () => void;
  onClose: () => void;
}

const MODE_LABEL = { fidelity: '忠実度優先', readable: '読みやすさ優先' } as const;

export function MidiImportPanel({ doc, source, busy, canRestoreBackup, onSourceChange, onReconvert, onRestoreBackup, onClose }: Props) {
  const [mode, setMode] = useState<MidiImportOptions['mode']>(doc.options.mode);
  const [grid, setGrid] = useState<QuantizeGrid>(doc.options.quantize ?? '1/16');
  const s = doc.summary;
  const lost = s ? Object.entries(s.lostEvents) : [];
  const changed = mode !== doc.options.mode || (mode === 'readable' && grid !== (doc.options.quantize ?? '1/16'));

  return (
    <section className="panel midi-import" aria-labelledby="midi-title" data-testid="midi-panel">
      <h2 id="midi-title">
        MIDI インポート <span className="count">{doc.fileName}</span>
      </h2>

      <fieldset className="source-toggle">
        <legend>再生するもの</legend>
        <label>
          <input type="radio" name="play-source" value="mml" checked={source === 'mml'} disabled={!doc.generatedMml && source !== 'mml'} onChange={() => onSourceChange('mml')} />
          MML（エディタの内容）
        </label>
        <label>
          <input type="radio" name="play-source" value="original" checked={source === 'original'} onChange={() => onSourceChange('original')} />
          元 MIDI（変更されません）
        </label>
      </fieldset>

      <div className="convert-row">
        <label>
          変換モード{' '}
          <select aria-label="変換モード" value={mode} onChange={(e) => setMode(e.target.value as MidiImportOptions['mode'])} disabled={busy}>
            <option value="fidelity">{MODE_LABEL.fidelity}</option>
            <option value="readable">{MODE_LABEL.readable}</option>
          </select>
        </label>
        <label>
          量子化{' '}
          <select aria-label="量子化単位" value={grid} onChange={(e) => setGrid(e.target.value as QuantizeGrid)} disabled={busy || mode !== 'readable'}>
            <option value="1/8">1/8</option>
            <option value="1/16">1/16</option>
            <option value="1/32">1/32</option>
          </select>
        </label>
        <button type="button" className="small-btn" disabled={busy} onClick={() => onReconvert({ mode, quantize: mode === 'readable' ? grid : undefined })}>
          {changed ? 'このモードで再変換' : '再変換'}
        </button>
      </div>

      {busy && <p className="muted small">変換中…</p>}

      {doc.issues.length > 0 && (
        <div className="msg-error small" role="alert" data-testid="import-errors">
          <p>✖ MML に変換できませんでした。{doc.bytes.length > 0 && '元 MIDI は再生できます。'}</p>
          <ul>
            {doc.issues.slice(0, 12).map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}

      {s && (
        <>
          <p className={s.roundTrip.ok ? 'verify-ok' : 'msg-error'} data-testid="roundtrip-status" data-ok={s.roundTrip.ok}>
            {s.roundTrip.ok ? '✔' : '✖'} {MODE_LABEL[s.mode]}
            {s.mode === 'readable' && s.quantize ? `（${s.quantize.grid} tick グリッド）` : ''}: 再コンパイル検証
            {s.roundTrip.ok ? '一致' : `不一致 ${s.roundTrip.mismatchCount} 件`}
            <span className="muted small">
              {' '}
              （ノート {s.roundTrip.compared.notes} / テンポ {s.roundTrip.compared.tempos} / 音色 {s.roundTrip.compared.programs} / CC {s.roundTrip.compared.cc} / PB {s.roundTrip.compared.pitchbend}）
            </span>
          </p>
          <dl className="import-facts">
            <dt>形式</dt>
            <dd>SMF Format {s.originalFormat}</dd>
            <dt>元 PPQ</dt>
            <dd>{s.originalPpq} → 480</dd>
            <dt>トラック / チャンネル</dt>
            <dd>
              {s.sourceTracks} / {s.sourceChannels}
            </dd>
            <dt>ノート数</dt>
            <dd>{s.noteCount}</dd>
            <dt>曲の長さ</dt>
            <dd>{formatTime(s.originalDurationSeconds)}</dd>
            <dt>PPQ 丸め誤差</dt>
            <dd>最大 {s.roundingMaxErrorTicks} tick</dd>
            {s.quantize && (
              <>
                <dt>量子化の差</dt>
                <dd data-testid="quantize-diff">
                  開始 {s.quantize.notesMoved} 音（最大 {s.quantize.maxStartShift} tick）・長さ {s.quantize.notesResized} 音（終了差 最大 {s.quantize.maxEndShift} tick）
                  {s.quantize.fallbackChannels.length > 0 && `・正確な tick で出力: CH${s.quantize.fallbackChannels.join(', CH')}`}
                </dd>
              </>
            )}
          </dl>
          {lost.length > 0 && (
            <div className="msg-warning small" data-testid="lost-events">
              ⚠ MML に変換できなかったイベント（元 MIDI の再生では保持）:
              <ul>
                {lost.map(([k, n]) => (
                  <li key={k}>
                    {k} × {n}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.warnings.filter((w) => !w.startsWith('MML に変換できないイベント')).length > 0 && (
            <details className="import-warnings">
              <summary>変換時の警告（{s.warnings.filter((w) => !w.startsWith('MML に変換できないイベント')).length} 件）</summary>
              <ul className="small">
                {s.warnings
                  .filter((w) => !w.startsWith('MML に変換できないイベント'))
                  .map((w, k) => (
                    <li key={k}>⚠ {w}</li>
                  ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="sf-actions">
        {canRestoreBackup && (
          <button type="button" className="small-btn" onClick={onRestoreBackup}>
            変換前の MML に戻す
          </button>
        )}
        <button type="button" className="link-btn" onClick={onClose}>
          インポート情報を閉じる
        </button>
      </div>
      <p className="muted small">MIDI はブラウザ内だけで処理し、アップロードしません。MML を編集しても元 MIDI は変わりません。</p>
    </section>
  );
}
