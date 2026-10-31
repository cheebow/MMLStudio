import { useMemo, useRef, useState } from 'react';
import { convertDialect, DIALECTS, guessDialect, listDialectSongs, type DialectConvertResult, type DialectId } from '../engine/dialects';
import { readTextUtf8OrSjis } from '../utils/files';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the converted MML; the parent confirms / backs up before replacing the editor. */
  onApply: (mml: string, title: string | undefined) => void;
}

const PLACEHOLDER: Record<DialectId, string> = {
  'pc98-play': '例:\n"0001","曲名",2,3,6\n01 "T140L8O4CDEFG","O3C2E2"\n02 "AB>C4","G1"',
  sakura: "例:\nTempo=120\nTR 1 @1 o5 l8 cdefgab>c\nTR 2 @33 o3 'ceg'2 'dfa'2\n// 日本語 MML も可: トラック３ 音階５ ドレミファソー",
};

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
  const [bestEffort, setBestEffort] = useState(false);
  const [result, setResult] = useState<DialectConvertResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const songs = useMemo(() => listDialectSongs(text, dialect), [text, dialect]);
  const guessed = useMemo(() => guessDialect(text), [text]);

  const changeText = (t: string) => {
    setFileNote(null);
    setText(t);
    setResult(null);
    setSongIndex(0);
    const g = guessDialect(t);
    if (g) setDialect(g);
  };
  const convert = () => setResult(convertDialect(text, dialect, { songIndex, bestEffort: dialect === 'sakura' && bestEffort }));
  const skippable = (r: DialectConvertResult | null) =>
    !!r && !r.ok && dialect === 'sakura' && !bestEffort && r.errors.some((e) => ['E_SAKURA_UNSUPPORTED', 'E_SAKURA_EXPR', 'E_SAKURA_UNKNOWN'].includes(e.code));
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
            readTextUtf8OrSjis(f).then(
              ({ text: t, encoding }) => {
                setFileError(null);
                changeText(t);
                if (encoding === 'shift_jis') setFileNote(`「${f.name}」を Shift_JIS のテキストとして読み込みました。`);
              },
              () => setFileError(`「${f.name}」は UTF-8・Shift_JIS のどちらのテキストとしても読めませんでした。`),
            );
          }}
        />
      </div>
      {fileError && <p className="msg-error small">✖ {fileError}</p>}
      {fileNote && (
        <p className="muted small" data-testid="dialect-file-note">
          {fileNote}
        </p>
      )}
      <textarea
        className="dialect-input"
        aria-label="変換する MML"
        spellCheck={false}
        placeholder={PLACEHOLDER[dialect]}
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
        {dialect === 'sakura' && (
          <label className="small">
            <input type="checkbox" checked={bestEffort} onChange={(e) => (setBestEffort(e.target.checked), setResult(null))} /> 変換できない命令はスキップする（近似変換）
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
          {skippable(result) && <p>「変換できない命令はスキップする（近似変換）」をオンにすると、変換できない部分を飛ばして変換できます（元の曲と同じには鳴りません）。</p>}
        </div>
      )}
      {result?.ok && (
        <>
          <p className="verify-ok" data-testid="dialect-status">
            ✔ {result.summary.parts} {dialect === 'pc98-play' ? 'パート' : 'トラック'}・{result.summary.notes} 音を変換しました（{result.summary.approximate ? '近似変換・' : ''}再コンパイル検証 一致）
          </p>
          {result.summary.approximate && (
            <p className="msg-warning small" data-testid="dialect-approximate">
              ⚠ 変換できない命令をスキップしたため、元の曲と同じには鳴りません。スキップした内容は下の注意（「近似変換」と書かれた項目）を確認してください。
            </p>
          )}
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
