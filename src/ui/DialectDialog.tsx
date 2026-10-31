import { useMemo, useRef, useState } from 'react';
import { convertDialect, DIALECTS, guessDialect, listDialectSongs, type DialectConvertResult, type DialectId } from '../engine';
import { readUtf8 } from '../utils/files';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the converted MML; the parent confirms / backs up before replacing the editor. */
  onApply: (mml: string, title: string | undefined) => void;
}

/** Paste MML written for another dialect and convert it into MML Studio MML (SPEC 4.5.6). */
export function DialectDialog({ open, onClose, onApply }: Props) {
  return (
    <Modal open={open} title="他の MML から変換" onClose={onClose} wide>
      <DialectForm onApply={onApply} />
    </Modal>
  );
}

function DialectForm({ onApply }: Pick<Props, 'onApply'>) {
  const [text, setText] = useState('');
  const [dialect, setDialect] = useState<DialectId>('pc98-play');
  const [songIndex, setSongIndex] = useState(0);
  const [result, setResult] = useState<DialectConvertResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const songs = useMemo(() => listDialectSongs(text, dialect), [text, dialect]);
  const guessed = useMemo(() => guessDialect(text), [text]);

  const changeText = (t: string) => {
    setText(t);
    setResult(null);
    setSongIndex(0);
    const g = guessDialect(t);
    if (g) setDialect(g);
  };
  const convert = () => setResult(convertDialect(text, dialect, { songIndex }));
  const title = songs[songIndex]?.title;

  return (
    <div className="dialect">
      <p className="small">
        他の MML 方言で書かれたテキストを貼り付けると、MML Studio の MML に書き換えます。変換できない命令や推定で変換した命令は、元のテキストの行・列付きで表示します。
        処理はすべてブラウザ内で行います。
      </p>
      <div className="convert-row">
        <label>
          方言{' '}
          <select aria-label="方言" value={dialect} onChange={(e) => (setDialect(e.target.value as DialectId), setResult(null))}>
            {DIALECTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {text.trim() !== '' && <span className="muted small">{guessed ? `自動判定: ${DIALECTS.find((d) => d.id === guessed)?.label}` : '自動判定: 不明（方言を選んでください）'}</span>}
        <button type="button" className="small-btn" onClick={() => fileRef.current?.click()}>
          テキストファイルを読み込む…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.mml,text/plain"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="変換するテキストファイル"
          data-testid="dialect-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            readUtf8(f).then(
              (t) => (setFileError(null), changeText(t)),
              () => setFileError(`「${f.name}」は UTF-8 のテキストとして読めませんでした。`),
            );
          }}
        />
      </div>
      {fileError && <p className="msg-error small">✖ {fileError}</p>}
      <textarea
        className="dialect-input"
        aria-label="変換する MML"
        spellCheck={false}
        placeholder={'例:\n"0001","曲名",2,3,6\n01 "T140L8O4CDEFG","O3C2E2"\n02 "AB>C4","G1"'}
        value={text}
        onChange={(e) => changeText(e.target.value)}
      />
      <div className="convert-row">
        {songs.length > 1 && (
          <label>
            曲{' '}
            <select aria-label="変換する曲" value={songIndex} onChange={(e) => (setSongIndex(Number(e.target.value)), setResult(null))}>
              {songs.map((s) => (
                <option key={s.index} value={s.index}>
                  {s.title ?? `${s.startLine} 行目から`}（{s.parts} パート）
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="tool-btn" onClick={convert} disabled={text.trim() === ''}>
          変換
        </button>
      </div>

      {result && !result.ok && (
        <div className="msg-error small" role="alert" data-testid="dialect-errors">
          ✖ 変換できませんでした。
          <ul>
            {result.errors.map((e, i) => (
              <li key={i}>
                {e.line}行{e.column}列: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result?.ok && (
        <>
          <p className="verify-ok" data-testid="dialect-status">
            ✔ {result.summary.parts} パート・{result.summary.notes} 音を変換しました（再コンパイル検証 一致）
          </p>
          {result.warnings.length > 0 && (
            <div className="msg-warning small" data-testid="dialect-warnings">
              ⚠ 注意（{result.warnings.length} 種類）:
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>
                    {w.line}行{w.column}列{w.count && w.count > 1 ? ` ほか（計 ${w.count} 箇所）` : ''}: {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <pre className="dialect-preview" aria-label="変換結果のプレビュー">
            {result.mml}
          </pre>
          <div className="convert-row">
            <button type="button" className="tool-btn primary-btn" onClick={() => onApply(result.mml, title)}>
              エディタに反映
            </button>
          </div>
        </>
      )}
    </div>
  );
}
