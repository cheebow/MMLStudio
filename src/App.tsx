import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compileMml, LIMITS, MIDI_LIMITS, ticksToSeconds, writeSmf, type CompileResult, type CompiledSong, type Diagnostic, type MidiImportOptions } from './engine';
import { usePlayer } from './hooks/usePlayer';
import { DEFAULT_SAMPLE, SAMPLES } from './samples';
import { DiagnosticsPanel } from './ui/DiagnosticsPanel';
import { HelpDialog } from './ui/HelpDialog';
import { InstrumentDialog } from './ui/InstrumentDialog';
import { LicenseDialog } from './ui/LicenseDialog';
import { MidiImportPanel, type MidiDocument, type PlaySource } from './ui/MidiImportPanel';
import { MmlEditor, type MmlEditorHandle } from './ui/MmlEditor';
import { SoundFontSelector } from './ui/SoundFontSelector';
import { TrackList } from './ui/TrackList';
import { TransportBar } from './ui/TransportBar';
import { loadDraft, saveDraft } from './utils/draft';
import { baseName, downloadBytes, readUtf8 } from './utils/files';
import { MidiImportCancelled, runMidiImportWithFallback } from './workers/midiImportClient';

const COMPILE_DEBOUNCE_MS = 250;
const MAX_COMPILE_DEBOUNCE_MS = 2000;
const DRAFT_DEBOUNCE_MS = 800;

function countNotes(song: CompiledSong): number {
  return song.tracks.reduce((n, t) => n + t.events.filter((e) => e.kind === 'note').length, 0);
}

interface Initial {
  source: string;
  fileName: string | null;
  restored: boolean;
}

function initialDocument(): Initial {
  const draft = loadDraft();
  if (draft) return { source: draft.source, fileName: draft.fileName, restored: true };
  return { source: DEFAULT_SAMPLE.source, fileName: null, restored: false };
}

type DialogName = 'help' | 'instruments' | 'license' | null;

async function looksLikeSmf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head.length === 4 && String.fromCharCode(...head) === 'MThd';
}

export default function App() {
  const [initial] = useState(initialDocument);
  const editorRef = useRef<MmlEditorHandle>(null);
  const mmlInputRef = useRef<HTMLInputElement>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);
  const importJob = useRef<{ cancel: () => void } | null>(null);
  const [midiDoc, setMidiDoc] = useState<MidiDocument | null>(null);
  const [playSource, setPlaySource] = useState<PlaySource>('mml');
  const [importBusy, setImportBusy] = useState(false);
  const [backup, setBackup] = useState<{ text: string; fileName: string | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState(initial.source);
  const [fileName, setFileName] = useState<string | null>(initial.fileName);
  const [result, setResult] = useState<CompileResult>(() => compileMml(initial.source));
  const [lastGood, setLastGood] = useState<CompiledSong | null>(() => {
    const r = compileMml(initial.source);
    return r.ok ? r.song : null;
  });
  const [notice, setNotice] = useState<string | null>(initial.restored ? '前回の下書きを復元しました。' : null);
  const [dirty, setDirty] = useState(initial.restored);
  const [dialog, setDialog] = useState<DialogName>(null);
  const player = usePlayer();

  // Background compile for diagnostics / track list only. Playback recompiles on "play".
  // The debounce grows with the measured compile time so large documents stay responsive.
  const compileCost = useRef(0);
  useEffect(() => {
    const delay = Math.min(MAX_COMPILE_DEBOUNCE_MS, Math.max(COMPILE_DEBOUNCE_MS, compileCost.current * 3));
    const id = setTimeout(() => {
      const started = performance.now();
      const r = compileMml(source);
      compileCost.current = performance.now() - started;
      setResult(r);
      if (r.ok) setLastGood(r.song);
    }, delay);
    return () => clearTimeout(id);
  }, [source]);

  // Draft autosave (debounced). Failure (e.g. storage disabled) is non-fatal.
  useEffect(() => {
    const id = setTimeout(() => saveDraft({ source, fileName, savedAt: Date.now() }), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [source, fileName]);

  const diagnostics: Diagnostic[] = result.diagnostics;
  const hasErrors = !result.ok;
  const songDuration = useMemo(() => (lastGood ? ticksToSeconds(lastGood.endTick, lastGood.tempoMap) : 0), [lastGood]);
  const busy = player.state === 'loading-soundfont' || player.state === 'compiling';
  const outputBase = fileName ? baseName(fileName) : 'song';

  const onChange = useCallback((text: string) => {
    setSource(text);
    setDirty(true);
  }, []);

  const jump = useCallback((d: Diagnostic) => {
    editorRef.current?.jumpTo(d.span.startOffset, d.span.endOffset);
  }, []);

  const compileCurrent = (): CompileResult => {
    const r = compileMml(editorRef.current?.getValue() ?? source);
    setResult(r);
    if (r.ok) setLastGood(r.song);
    return r;
  };

  useEffect(() => () => importJob.current?.cancel(), []);

  const playingOriginal = playSource === 'original' && midiDoc !== null;

  const handlePlay = () => {
    setNotice(null);
    if (playingOriginal) {
      const doc = midiDoc;
      // The original bytes are never modified; the player gets its own copy.
      void player.play(() => ({ smf: doc.bytes.slice(), fileName: doc.fileName }));
      return;
    }
    void player.play(() => {
      const r = compileCurrent();
      if (!r.ok) {
        setNotice('MML にエラーがあるため再生できません。エラー一覧を確認してください。');
        return null;
      }
      if (countNotes(r.song) === 0) {
        setNotice('演奏する音符がありません。');
        return null;
      }
      return { smf: writeSmf(r.song), fileName: `${outputBase}.mid` };
    });
  };

  const confirmDiscard = (what: string) => !dirty || window.confirm(`編集中の MML を破棄して${what}を開きますか？（下書きは上書きされます）`);

  const replaceDocument = (text: string, name: string | null) => {
    player.stop();
    editorRef.current?.setValue(text);
    setSource(text);
    setFileName(name);
    setDirty(false);
  };

  const loadSample = (id: string) => {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample || !confirmDiscard('サンプル')) return;
    replaceDocument(sample.source, null);
    setNotice(`サンプル「${sample.title}」を読み込みました。`);
  };

  const openMmlFile = async (file: File) => {
    if (file.size > LIMITS.maxSourceBytes) {
      setNotice(`ファイルが大きすぎます（上限 ${LIMITS.maxSourceBytes / 1024 / 1024} MiB）。`);
      return;
    }
    if (!confirmDiscard(`「${file.name}」`)) return;
    try {
      const text = await readUtf8(file);
      replaceDocument(text, file.name);
      setNotice(`「${file.name}」を開きました。`);
    } catch {
      setNotice(`「${file.name}」は UTF-8 のテキストとして読めませんでした。`);
    }
  };

  const saveMml = () => {
    const text = editorRef.current?.getValue() ?? source;
    const name = `${outputBase}.mml`;
    downloadBytes(text, name, 'text/plain;charset=utf-8');
    setFileName(name);
    setDirty(false);
    setNotice(`「${name}」として保存しました。`);
  };

  const convertMidi = async (name: string, bytes: Uint8Array, options: MidiImportOptions) => {
    importJob.current?.cancel();
    const job = runMidiImportWithFallback(bytes, { ...options, fileName: name });
    importJob.current = job;
    setImportBusy(true);
    try {
      const { result: r, usedFallback } = await job.promise;
      if (usedFallback) console.warn('MIDI import ran on the main thread (Web Worker unavailable).');
      if (importJob.current !== job) return;
      if (r.ok) {
        // Keep what the editor had so it can be restored.
        setBackup({ text: editorRef.current?.getValue() ?? source, fileName });
        replaceDocument(r.mml, `${baseName(name)}.mml`);
        setMidiDoc({ fileName: name, bytes, options, summary: r.summary, issues: [], generatedMml: r.mml });
        setPlaySource('mml');
        const lost = Object.values(r.summary.lostEvents).reduce((a, b) => a + b, 0);
        setNotice(
          `「${name}」を MML に変換しました（${r.summary.mode === 'fidelity' ? '忠実度優先' : '読みやすさ優先'}・再コンパイル検証 一致）。${lost > 0 ? `変換できなかったイベントが ${lost} 個あります（インポート情報を参照）。` : ''}`,
        );
      } else if (r.originalPlayable) {
        player.stop();
        setMidiDoc({ fileName: name, bytes, options, summary: null, issues: r.issues, generatedMml: null });
        setPlaySource('original');
        setNotice(`「${name}」は MML に変換できませんでした。元 MIDI は再生できます。`);
      } else {
        setNotice(`「${name}」を MIDI として読み込めませんでした: ${r.issues[0]?.message ?? '不明なエラー'}`);
      }
    } catch (e) {
      if (!(e instanceof MidiImportCancelled)) setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      if (importJob.current === job) {
        importJob.current = null;
        setImportBusy(false);
      }
    }
  };

  const openMidiFile = async (file: File) => {
    if (file.size > MIDI_LIMITS.maxBytes) {
      setNotice(`MIDI ファイルが大きすぎます（上限 ${MIDI_LIMITS.maxBytes / 1024 / 1024} MiB）。`);
      return;
    }
    if (!confirmDiscard(`「${file.name}」`)) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await convertMidi(file.name, bytes, { mode: midiDoc?.options.mode ?? 'fidelity', quantize: midiDoc?.options.quantize });
  };

  const reconvert = (options: MidiImportOptions) => {
    if (!midiDoc) return;
    const current = editorRef.current?.getValue() ?? source;
    if (midiDoc.generatedMml !== null && current !== midiDoc.generatedMml && !window.confirm('編集した MML を破棄して再変換しますか？（現在の内容は「変換前の MML に戻す」で復元できます）')) return;
    void convertMidi(midiDoc.fileName, midiDoc.bytes, options);
  };

  const restoreBackup = () => {
    if (!backup) return;
    replaceDocument(backup.text, backup.fileName);
    setBackup(null);
    setPlaySource('mml');
    setNotice('変換前の MML に戻しました。');
  };

  const changePlaySource = (s: PlaySource) => {
    player.stop();
    setPlaySource(s);
  };

  const closeMidi = () => {
    importJob.current?.cancel();
    player.stop();
    setMidiDoc(null);
    setPlaySource('mml');
  };

  const openDropped = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.sf2')) {
      void player.selectSoundFont({ kind: 'local', name: file.name, file });
    } else if (lower.endsWith('.mid') || lower.endsWith('.midi') || (await looksLikeSmf(file))) {
      await openMidiFile(file);
    } else {
      await openMmlFile(file);
    }
  };

  const exportMidi = () => {
    const r = compileCurrent();
    if (!r.ok) {
      setNotice('MML にエラーがあるため MIDI を書き出せません。');
      return;
    }
    const bytes = writeSmf(r.song);
    downloadBytes(bytes.slice().buffer, `${outputBase}.mid`, 'audio/midi');
    setNotice(`「${outputBase}.mid」（SMF Type 1）を書き出しました。`);
  };

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null || !(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) void openDropped(f);
      }}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          MIDI（.mid）・MML・SF2 ファイルをドロップして開く
        </div>
      )}
      <header className="app-header">
        <h1>MML Studio</h1>
        <nav className="toolbar" aria-label="ファイル操作">
          <button type="button" className="tool-btn" onClick={() => mmlInputRef.current?.click()}>
            MMLを開く
          </button>
          <input
            ref={mmlInputRef}
            type="file"
            accept=".mml,.txt,text/plain"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="MML ファイル"
            data-testid="mml-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void openMmlFile(f);
            }}
          />
          <button type="button" className="tool-btn" onClick={() => midiInputRef.current?.click()} disabled={importBusy}>
            MIDIを開く
          </button>
          <input
            ref={midiInputRef}
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="MIDI ファイル"
            data-testid="midi-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void openMidiFile(f);
            }}
          />
          <button type="button" className="tool-btn" onClick={saveMml}>
            MML保存
          </button>
          <button type="button" className="tool-btn" onClick={exportMidi} disabled={hasErrors} title={hasErrors ? 'エラーがあるため書き出せません' : 'SMF Type 1 で書き出し'}>
            MIDI書き出し
          </button>
          <label className="sample-picker">
            <span className="visually-hidden">サンプル</span>
            <select aria-label="サンプルを読み込む" value="" onChange={(e) => loadSample(e.target.value)}>
              <option value="" disabled>
                サンプル…
              </option>
              {SAMPLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        </nav>
        <nav className="toolbar toolbar-right" aria-label="情報">
          <button type="button" className="tool-btn" onClick={() => setDialog('instruments')}>
            音色一覧
          </button>
          <button type="button" className="tool-btn" onClick={() => setDialog('help')}>
            ヘルプ
          </button>
        </nav>
        <span className="doc-name" data-testid="doc-name">
          {fileName ?? '無題'}
          {dirty ? ' ●' : ''}
          {dirty && <span className="visually-hidden">（未保存の変更あり）</span>}
        </span>
      </header>

      <main className="workspace">
        <div className="editor-pane">
          <MmlEditor ref={editorRef} initialValue={initial.source} diagnostics={diagnostics} onChange={onChange} />
        </div>
        <aside className="side-pane">
          {midiDoc && (
            <MidiImportPanel
              key={`${midiDoc.fileName}:${midiDoc.options.mode}:${midiDoc.options.quantize ?? ''}`}
              doc={midiDoc}
              source={playSource}
              busy={importBusy}
              canRestoreBackup={backup !== null}
              onSourceChange={changePlaySource}
              onReconvert={reconvert}
              onRestoreBackup={restoreBackup}
              onClose={closeMidi}
            />
          )}
          <TrackList song={lastGood} stale={hasErrors} />
          <DiagnosticsPanel diagnostics={diagnostics} onJump={jump} />
          <SoundFontSelector
            info={player.soundFont}
            busy={busy}
            onSelectDefault={() => void player.selectSoundFont({ kind: 'default' })}
            onSelectLocal={(file) => void player.selectSoundFont({ kind: 'local', name: file.name, file })}
            onShowLicense={() => setDialog('license')}
          />
        </aside>
      </main>

      <footer className="player">
        <TransportBar
          state={player.state}
          currentTime={player.currentTime}
          duration={player.state === 'playing' || player.state === 'paused' ? player.duration : playingOriginal ? (midiDoc.summary?.originalDurationSeconds ?? 0) : songDuration}
          canPlay={playingOriginal || !hasErrors}
          onPlay={handlePlay}
          onPause={player.pause}
          onStop={player.stop}
          onSeek={player.seek}
        />
        <div className="messages" aria-live="polite">
          {player.soundFont.status === 'loading' && (
            <span>
              音源を読み込み中…
              {player.soundFont.progress !== null && ` ${Math.round(player.soundFont.progress * 100)}%`}
            </span>
          )}
          {player.error && <span className="msg-error">✖ {player.error}</span>}
          {importBusy && <span>MIDI を変換中…</span>}
          {playingOriginal && <span className="source-badge">▶ 元 MIDI を再生します（MML の編集は反映されません）</span>}
          {notice && <span className="msg-info">ℹ {notice}</span>}
          {hasErrors && !playingOriginal && <span className="msg-error">✖ MML にエラーがあります（再生と MIDI 書き出しは無効）</span>}
        </div>
      </footer>

      <HelpDialog open={dialog === 'help'} onClose={() => setDialog(null)} />
      <InstrumentDialog open={dialog === 'instruments'} onClose={() => setDialog(null)} />
      <LicenseDialog open={dialog === 'license'} onClose={() => setDialog(null)} />
    </div>
  );
}
