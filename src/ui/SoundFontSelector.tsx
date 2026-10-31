import { useRef } from 'react';
import type { SoundFontInfo } from '../hooks/usePlayer';
import { instrumentName } from '../audio/instrument-names';

interface Props {
  info: SoundFontInfo;
  busy: boolean;
  onSelectDefault: () => void;
  onSelectLocal: (file: File) => void;
  onShowLicense: () => void;
}

const STATUS: Record<SoundFontInfo['status'], string> = {
  'not-loaded': '未読込（最初の再生時に読み込みます）',
  loading: '読み込み中…',
  loaded: '読込済み',
  error: '読み込み失敗',
};

export function SoundFontSelector({ info, busy, onSelectDefault, onSelectLocal, onShowLicense }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const report = info.report;
  return (
    <section className="panel soundfont" aria-labelledby="sf-title">
      <h2 id="sf-title">音源（SoundFont）</h2>
      <p className="sf-current">
        <strong>{info.name}</strong>
        <br />
        <span className={info.status === 'error' ? 'msg-error' : 'muted'} data-testid="soundfont-status" data-status={info.status}>
          {info.status === 'error' ? '✖ ' : ''}
          {STATUS[info.status]}
          {info.status === 'loading' && info.progress !== null && ` ${Math.round(info.progress * 100)}%`}
        </span>
      </p>
      {info.error && <p className="msg-error small">{info.error}</p>}
      {report && (report.missingPrograms.length > 0 || !report.hasDrumKit) && (
        <p className="msg-warning small" role="note">
          ⚠ この SoundFont は GM 音色を完全には持っていません
          {report.missingPrograms.length > 0 &&
            `（不足 ${report.missingPrograms.length} 音色: ${report.missingPrograms
              .slice(0, 3)
              .map((p) => `@${p + 1} ${instrumentName(p)}`)
              .join(', ')}${report.missingPrograms.length > 3 ? ' …' : ''}）`}
          {!report.hasDrumKit && '（ドラムキットがありません）'}。指定した音色どおりに鳴らない場合があります。
        </p>
      )}
      <div className="sf-actions">
        <button type="button" className="small-btn" onClick={onSelectDefault} disabled={busy || (info.kind === 'default' && info.status === 'loaded')}>
          標準音源に戻す
        </button>
        <button type="button" className="small-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          ローカル SF2 を読み込む…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".sf2,audio/x-soundfont"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="ローカル SF2 ファイル"
          data-testid="sf2-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onSelectLocal(f);
          }}
        />
        <button type="button" className="link-btn" onClick={onShowLicense}>
          音源情報・ライセンス
        </button>
      </div>
      <p className="muted small">ローカル SF2 はブラウザ内だけで読み込み、アップロードしません。再読み込みすると標準音源に戻ります。</p>
    </section>
  );
}
