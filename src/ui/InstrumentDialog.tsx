import { useMemo, useState } from 'react';
import { GM_INSTRUMENTS } from '../audio/instrument-names';
import { Modal } from './Modal';

const FAMILIES = ['Piano', 'Chromatic Percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'Ethnic', 'Percussive', 'Sound Effects'];

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Reference / copy only. Never edits the editor source (SPEC 12). */
export function InstrumentDialog({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<number | null>(null);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GM_INSTRUMENTS.map((name, i) => ({ n: i + 1, name, family: FAMILIES[Math.floor(i / 8)] })).filter(
      (r) => !q || r.name.toLowerCase().includes(q) || r.family.toLowerCase().includes(q) || `@${r.n}` === q || String(r.n) === q,
    );
  }, [query]);

  const copy = async (n: number) => {
    try {
      await navigator.clipboard.writeText(`@${n}`);
      setCopied(n);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Modal open={open} title="GM 音色一覧（@1〜@128）" onClose={onClose} wide>
      <p className="muted small">
        MML では <code>@N</code>（1 始まり）で指定します。MIDI の Program 番号は N−1 です。ドラム（CH(10)）では @ は使えません。
      </p>
      <input
        type="search"
        className="search"
        placeholder="名前・分類・番号で検索（例: strings, 49）"
        aria-label="音色を検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="instrument-scroll">
        <table className="track-table">
          <thead>
            <tr>
              <th scope="col">@</th>
              <th scope="col">音色名</th>
              <th scope="col">分類</th>
              <th scope="col">
                <span className="visually-hidden">コピー</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.n}>
                <td>@{r.n}</td>
                <td>{r.name}</td>
                <td className="muted">{r.family}</td>
                <td>
                  <button type="button" className="small-btn" onClick={() => copy(r.n)} aria-label={`@${r.n} をコピー`}>
                    {copied === r.n ? 'コピー済み' : 'コピー'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">該当する音色はありません。</p>}
      </div>
    </Modal>
  );
}
