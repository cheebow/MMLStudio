import { useEffect, useState } from 'react';
import { Modal } from './Modal';

const FILES = [
  { title: 'GeneralUser GS v2.0.3（標準 SoundFont）', path: 'licenses/GeneralUser-GS-LICENSE.txt' },
  { title: 'spessasynth_lib（音声合成ライブラリ, Apache-2.0）', path: 'licenses/spessasynth_lib-LICENSE.txt' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function LicenseDialog({ open, onClose }: Props) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const f of FILES) {
      fetch(`${import.meta.env.BASE_URL}${f.path}`)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((t) => alive && setTexts((s) => ({ ...s, [f.path]: t })))
        .catch((e: Error) => alive && setTexts((s) => ({ ...s, [f.path]: `ライセンス文書を読み込めませんでした（${e.message}）。` })));
    }
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <Modal open={open} title="音源情報・ライセンス" onClose={onClose} wide>
      <p>
        標準音源は S. Christian Collins 氏による <strong>GeneralUser GS v2.0.3</strong> です。作者の公式配布物（
        <a href="https://www.schristiancollins.com/generaluser" target="_blank" rel="noreferrer">
          公式サイト
        </a>
        ・
        <a href="https://github.com/mrbumpy409/GeneralUser-GS" target="_blank" rel="noreferrer">
          公式 GitHub
        </a>
        ）から取得したファイルを、このサイトから配信しています。MML Studio 自体のライセンスと音源素材のライセンスは別です。
      </p>
      <p className="muted small">音源の鳴り方は SoundFont とブラウザに依存し、他のソフトと完全に同じ音になることは保証しません。</p>
      {FILES.map((f) => (
        <section key={f.path}>
          <h3>{f.title}</h3>
          <pre className="license-text">{texts[f.path] ?? '読み込み中…'}</pre>
        </section>
      ))}
    </Modal>
  );
}
