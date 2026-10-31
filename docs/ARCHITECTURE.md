# アーキテクチャ

```text
MML テキスト（CodeMirror）
   │  250ms debounce（診断・トラック一覧用）／「再生」「MIDI書き出し」時に再コンパイル
   ▼
src/engine（純粋 TypeScript・DOM/音声非依存）
   tokenizer.ts → parser.ts → compiler.ts → CompiledSong（IR）
                                              ├─ timing.ts（tick ↔ 秒）
                                              └─ smf-writer.ts → SMF Type 1 バイト列
   ▼
src/audio/SoundFontPlaybackAdapter.ts（spessasynth_lib を閉じ込める唯一の層。初回再生時に import() で遅延読込）
   AudioContext → AudioWorklet(spessasynth_processor.min.js) → WorkletSynthesizer + SF2 → Sequencer
```

- `src/engine` は ESLint（`no-restricted-imports` / `no-restricted-globals`）と DOM なしの `tsconfig.engine.json` で依存を機械的に制限している。
- `src/hooks/usePlayer.ts` が再生状態（idle / loading-soundfont / compiling / ready / playing / paused / error）と
  SoundFont 選択（世代番号で最新の選択だけを有効にし、ロードは直列化）を管理する。
- UI の時刻表示は `requestAnimationFrame` で Sequencer の時刻を読むだけで、発音のスケジューリングには使わない。
## MIDI → MML（Phase 4）

```text
.mid（File API / D&D） ── 元のバイト列（不変、元 MIDI 再生用にコピーを渡す）
   ▼ src/workers/midi-import.worker.ts（Web Worker、1 リクエスト 1 Worker、60 秒でタイムアウト。起動失敗時はメインスレッドで代替）
src/engine
   smf-reader.ts（Format 0/1、VLQ、running status、メタ/SysEx）→ ParsedMidi
   midi-normalizer.ts（チャンネル単位にマージ、Note On/Off の対応付け、480 PPQ へ丸め、欠落イベント集計）→ CanonSong
   midi-to-mml.ts（忠実度優先 / 読みやすさ優先）→ MML テキスト
   compileMml → midi-roundtrip.ts（期待イベントと再コンパイル結果を照合）→ MidiImportResult
```

- テスト: `tests/engine`、`tests/midi-import`（テスト専用の SMF ビルダー `tests/helpers/smf-build.ts`）（Vitest、独立した SMF パーサー `tests/helpers/smf-parse.ts` で検証）、`tests/e2e`（Playwright）。
