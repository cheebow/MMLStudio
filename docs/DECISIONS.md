# 設計判断の記録 (DECISIONS)

SPEC.md v1.1.0 を正本とし、仕様の解釈・変更・ライブラリ事情による調整をここに記録する。

## D-001 依存バージョンの固定（Phase 0, 2026-10-31）
- `spessasynth_lib` は **4.4.2** に固定（SPEC 2 が公開確認済みとしている版）。
- `spessasynth_lib@4.4.2` は `spessasynth_core` を `"latest"` で依存しているため、そのままでは非決定的。
  lib 4.4.2 の公開（2026-10-30 14:58Z）直前に公開された **spessasynth_core 4.4.3**（14:46Z）を `overrides` で固定した。
  worklet (`spessasynth_processor.min.js`) は lib の dist に同梱されたバンドルを `scripts/copy-worklet.mjs` で
  `postinstall`/`predev`/`prebuild` 時にコピーする（生成物として .gitignore）。
- TypeScript は 7.x が最新だが `typescript-eslint@8.72.1` の peer 範囲（<6.1.0）に合わせて **6.0.3** を採用。
- テストへの影響: なし（ユニットテストは SpessaSynth 非依存）。

## D-002 SpessaSynth API の確認結果（Phase 0）
インストール済み型定義 (`node_modules/spessasynth_lib/dist/index.d.ts`) で SPEC 5.3 の手順を確認:
- `new WorkletSynthesizer(context)`、`synth.connect(context.destination)`、`await synth.isReady`
- `synth.soundBankManager.addSoundBank(arrayBuffer, 'main')`（ArrayBuffer は transfer され detach される → 再利用しない）
- `new Sequencer(synth, { skipToFirstNoteOn: false })`、`loadNewSongList([{ binary, fileName }])`
- 読込完了は `sequencer.eventHandler.addEvent('songChange', id, cb)`、失敗は `'midiError'`
- `play()` / `pause()` / `currentTime`（setter でシーク）/ `currentHighResolutionTime`（UI表示用）/ `duration` / `paused` / `isFinished`
- `loop` プロパティは存在しない。ループ無効化は `sequencer.loopCount = 0` で行う。
- `synth.stopAll(true)`、`synth.destroy()`。
SPEC との差は `loop` のみ。すべて `src/audio/SoundFontPlaybackAdapter.ts` に閉じ込めている。

## D-003 標準 SoundFont の入手と配布（Phase 0）
- GeneralUser GS v2.0.3 を作者の公式 GitHub (`mrbumpy409/GeneralUser-GS`) のコミット
  `684543d5e5efaef08d02be50dcda8d552478fa60` から `npm run fetch-soundfont` で取得し、SHA-256
  (`9575028c…688cfe`) を検証して `public/soundfonts/GeneralUser-GS.sf2` に配置する。
- SF2 本体（約32MB）は .gitignore（リポジトリ肥大化回避）。ライセンス原文 `public/licenses/GeneralUser-GS-LICENSE.txt`
  と README はコミット対象。公開ビルドでは自サイトのコピーを配信し、作者のダウンロードファイルへはホットリンクしない。
- `spessasynth_lib` の Apache-2.0 ライセンスも `public/licenses/` に同梱する。

## D-004 同一 ch/pitch 重なり判定の区間（Phase 1 で適用予定）
`q%N` により発音長が記譜長を超え得る（SPEC 3.7）ため、重なり判定は記譜区間ではなく
**発音区間 [startTick, startTick + gateTicks)** で行う。gate=0（無音）のノートは判定対象外。

## D-005 サンプル 11.3 の注記
SPEC 11.3 の「コンダクタートラックで任意 tick に移動する構文は MVP には無い」は Phase 0〜3 に限った記述であり、
Phase 4 で `TR(0) Time(M:B:S) Tempo(N)` により解消される。

## D-006 複数文字コマンドの最長一致（Phase 1）
SPEC 3.1 は「大文字小文字を区別しない」「最長一致」を求めるが、そのままでは `cc4`（C音2つ）が `CC` と衝突する。
そこで複数文字コマンド（`Channel`, `TempoUS`, `Tempo`, `Track`, `Time`, `Sub`, `TR`, `CH`, `CC`, `PB`）は、
**直後（空白・タブは可）に引数開始文字が続く場合のみ**キーワードとして認識する（`(`、`TR`/`CH` は `=` も、`Sub` は `{`）。
`TR(1)` は t+r と誤認されず、`cc4` は2音のまま。テスト: `tests/engine/boundaries.test.ts`「longest match」。

## D-007 音長・値の隣接規則（Phase 1）
`c4`, `o5`, `@49` のように、音長・付点・臨時記号・数値引数は**直前の文字に空白を挟まず**続ける。
`c 4` は「予期しない数値」エラー（黙って読み飛ばさない）。`^`・`&` の前後と `( )` 内の空白は許可。
`nN` は数値が続くため分母音長を付けられない（`n604` が曖昧になる）。Phase 1 では既定 `l` のみ、Phase 4 で `%N`。

## D-008 チャンネル重複判定の対象（Phase 1）
重複判定の対象は「演奏イベントを持つ」または「`CH` を明示した」演奏トラック。
`TR(1) CH(2) c TR(2) e` は TR(2) の自動割当 CH2 と衝突するためエラー。空のトラックは対象外。
`CH` は音符・`@` などチャンネルを使うイベントの前でのみ変更可能（休符・`o`/`l`/`v`/`q` の後は可）。

## D-009 SMF 書き出しの細部（Phase 1）
- 暗黙の Program Change 0 は「tick 0 に Program Change が無い」非ドラム演奏トラックに出力する（途中で `@` があっても tick 0 の GM Piano を明示）。
- Note Off は `0x8n pitch 0`。running status は使わない。
- 全 MTrk の EOT を楽曲終端 tick（`endTick`）に揃え、末尾休符も曲長に含める。

## D-010 構文エラー時の意味解析（Phase 1）
字句・構文エラーがある場合は意味解析（トラック/チャンネル/テンポ判定）を行わず、構文エラーだけを返す。
誤った解析結果から連鎖的な誤報告が出るのを防ぐため。

## D-011 再生ボタンと再コンパイルの関係（Phase 2）
SPEC 5.3「再生し直した時点で最新ソースを再コンパイル」に従い、**停止/準備完了状態からの「再生」では常に最新のエディタ内容を再コンパイル**して
Sequencer へ読み込み直す。**一時停止中の「再開」は再コンパイルせず**同じ曲を続きから再生する（編集で再生位置を失わないため）。
編集を反映したいときは「停止」→「再生」。エディタの表示用コンパイル（診断・トラック一覧）は 250ms debounce で別に行い、再生中の曲には影響しない。
シークは再生中・一時停止中のみ有効。スライダーのドラッグ中は再生位置の表示更新を止め、確定（pointerup/keyup/blur）時に `sequencer.currentTime` を設定する。
曲の終了は `sequencer.isFinished` を rAF で監視して検出する（UI 表示専用。発音スケジューリングには使わない）。

## D-012 SoundFont 切替と GM 不足の通知（Phase 3）
- 切替時は再生を停止し、SoundFont のロードを**直列化**したうえで世代番号を比較し、最新の選択だけを反映する（古い要求の遅延完了は破棄）。
- 標準音源の読み込みは最初の「再生」まで遅延（初回表示で音源を強制ダウンロードしない、SPEC 6.2）。ローカル SF2 はファイル選択（ユーザー操作）時に即時読み込む。
- 読み込み後の `presetListChange` で bank 0 のメロディ音色 128 種とドラムキットの有無を確認し、不足があれば UI に警告する。
- ローカル SF2 の上限は 512 MiB（ブラウザのメモリ保護のための独自上限）。

## D-013 ファイル入出力・下書き（Phase 3）
- `.mml` は UTF-8（BOM 除去、不正なバイト列はエラー）として読む。2 MiB 超は開かない。
- 「未保存」は最後に開いた／保存した内容から変更があることを示す。下書き復元直後も未保存扱い（別ファイルを開く前に確認する）。
- 下書きは localStorage（キー `mml-studio:draft:v1`）に 800ms debounce で保存。ストレージ例外は無視して動作を継続する。

## D-014 Phase 4 言語拡張の細部
- `%N` は分母式・付点と併用不可（`c4%10`, `c%10.` は `E_LENGTH_MIX`）。`^` の後は分母式のみ（EBNF どおり）。`nN` には分母式を付けられない（D-007）ため `n60%240` のみ。
- 和音の構成音に音長を付けるとエラー。和音内の `<` `>` は一時的で外側のオクターブを変えない。同音高の重複・1音だけの和音はエラー。
- `Sub{}` の禁止命令（`TR` `CH` `t` `Tempo` `TempoUS` `Time`）はパーサーで位置付きエラーにする。`TR(0)` 内の `Sub` や和音は `E_CONDUCTOR`。
- 単独の `}` は「対応する Sub{ がない」構文エラー、単独の `{` は従来どおり連符として未対応エラー。
- 曲長（endTick）は各トラックの**到達した最大の演奏位置**（`Time` で巻き戻しても、`Sub` で戻っても先に進んだ位置）を含める。
- `TempoUS` と `t` の競合判定は μs 値（`t` は `round(60e6/BPM)`）。`TempoUS` の BPM は表示用に 60e6/μs（非整数可）。
- `q%N` で発音の終了が 2,000,000 tick を超える場合も `E_LIMIT`。
- テスト: `tests/engine/phase4-language.test.ts`

## D-015 SMF Reader の寛容さ（Phase 4）
SPEC 4.4.1 は「破損 SMF を部分的に正常扱いしない」。一方、実在ファイル約 2,100 件（ローカルの音源ライブラリ付属 MIDI）で検証したところ、
データは完全だが**形式上の不整合**を持つファイルが多数あった。次の場合に限り**警告付き**で読み込み、それ以外はエラーにする。
- MTrk のチャンク長が誤っている: End of Track まで読むと、**直後が次の `MTrk` ヘッダーかファイル末尾**になる場合のみ。
- メタイベント／SysEx の直後のランニングステータス: 直前のチャンネルステータスが存在する場合のみ（規格上は解除されるが多くのファイルが依存）。
- MacBinary（128 バイトのヘッダー、オフセット 128 に `MThd`）と RIFF RMID の `data` チャンクを取り除く。
VLQ が4バイト超、データバイトの最上位ビット、ステータス無しのランニングステータス、Format 2、SMPTE、上限超過はエラーのまま。
テスト: `tests/midi-import/import.test.ts`「reader leniency」。

## D-016 MIDI 正規化と比較の解釈（Phase 4）
- 全 MTrk を (tick, MTrk 番号, ファイル内順) で1本に並べてから処理する（決定的）。テンポは同 tick で最後のものを採用し警告。
- Note On/Off はチャンネル＋音高で対応付ける。重複 Note On では前の音を新しい音の開始で終わらせ、その音の Note Off は**後で来る最初の Note Off で消費**する（FIFO）。
  未終端ノートは曲の終端（最大の EOT）で終わらせる。480 PPQ への丸めで長さ 0 になる音は 1 tick、次の同音と重なる音は手前で終える（いずれも警告）。
- 拍子は tick 0 の 4/4 だけを保持済みとみなし（writer が常に書く）、それ以外は欠落として数える。ドラム（ch10）の Program Change は MML で書けないため欠落扱い。
- 比較（`compareMidiEvents(expected: CanonSong, compiled)`）: ノートは (ch, 音高, ベロシティ, on, off) の多重集合、Program/CC/PB はチャンネル・種類ごとに時刻順（同 tick 内の順序も）、
  テンポは tick と μs。既定の 120BPM と tick 0 の Program 0（非ドラム）は意味的初期状態として補う／除く。同 tick の CC と Note On の相対順序は writer の規則に従うため比較しない。
- SPEC の API 例 `compareMidiEvents(original: ParsedMidi, ...)` は、正規化後の `CanonSong` を受け取る形にした（PPQ 丸めと重複解決を一度だけ行うため）。
  `midiToMml(parsed, options, originalSmf?)` は生成・再コンパイル・照合までを行い、照合に失敗した場合は `ok: false`（MML を成功として返さない）。
  失敗結果は `Diagnostic`（ソース位置）ではなく `ImportIssue`（バイト位置・MTrk 番号）を返す。

## D-017 MML 生成の書式（Phase 4）
- TR 番号 = MIDI チャンネル番号（1〜16）、各トラックに `CH(N)` を明示。元の MTrk 番号・トラック名はコメントに残す（改行・制御文字は空白に置換）。
- 忠実度優先: 各 tick で「Time（位置がずれたとき・小節が変わったとき）→ CC/PB/@（元の順）→ 音符」。同 tick・同ゲート・同ベロシティの音は和音にし、
  ゲートかベロシティが異なる音は `Sub{}` で重ねる（cursor が正確に戻るため同じイベントを作れる）。音長 `%N` は次のイベントまでの距離にして `Time` を省き、ゲートは常に `q%N` で書く（既定 q90 に依存しない）。
  曲の終端（EOT）が最後のイベントより後なら `TR(0) Time(...)` で曲長を残す。
- 読みやすさ優先: 開始・終了を量子化（長さ 0 なら 1 グリッド）、`q100` で音長＝発音長。CC/PB/音色はトラック冒頭の「音色・コントローラ」節に `Time(...)` 付きで元の順に書く
  （バンクセレクトと Program の順序を保つため）。同じ開始・終了・ベロシティの音を和音にし、重なる音は貪欲法で声部に分けて `Time(...)` から書く。
  テンポとコントローラも同じグリッドに量子化する。テンポは `Tempo(BPM)` で厳密に表せるときだけ BPM 表記、他は `TempoUS`。
- 読みやすさ優先の検証は「量子化後の期待イベント」と再コンパイル結果の一致で行い、元 MIDI との差は QuantizeReport に数と最大 tick 差で示す。

## D-018 MIDI インポートの UI（Phase 4）
- 変換は Web Worker（1 リクエストごとに生成・終了、60 秒タイムアウト、新しい要求で前の要求を中止）。トラック名の文字コードは UTF-8 → Shift_JIS の順に試す（Worker 内の TextDecoder）。
- 元 MIDI のバイト列は読み込み時にコピーして保持し、再生時は毎回さらにコピーを渡す（Sequencer 側の転送・変更から守る）。
- 「再生するもの」を切り替えると再生を停止する。元 MIDI 再生中はエディタのエラーに関係なく再生できる。音源（標準／ローカル SF2）は共通。
- 変換成功時は直前のエディタ内容をバックアップし「変換前の MML に戻す」で復元できる。再変換時、生成結果から編集されていれば確認する。
- MML 化できない（曲長・サイズ上限、検証不一致）が SMF としては読めた場合は、エディタを変えずに元 MIDI だけ再生できる状態にする。
- 隠しファイル入力の配置基準をサイドパネルにし、長いインポート情報でページ全体がスクロールしないようにした（E2E で確認）。

## D-019 安定化（Phase 5）
- **音声の開始**: 「再生」・音源切替のクリック内で同期的に `AudioContext` を生成・`resume()` する（`adapter.unlock()`、Safari のユーザー操作要件）。
  `resume()` 5 秒、AudioWorklet 読込 15 秒、シンセ初期化 15 秒、曲の読込 20 秒でタイムアウトし、識別可能なエラーにする（以前はユーザー操作なしの再生で永久に「読み込み中 0%」だった）。失敗した AudioContext は閉じ、次のクリックで作り直す。
- **バンドル分割**: spessasynth_lib を `import()` で遅延読込し、初回表示に含めない（初回 JS 約 210 kB gzip、spessasynth は約 196 kB gzip を最初の再生時に取得）。`chunkSizeWarningLimit` は 700 kB。
- **背景コンパイル**: debounce を「前回のコンパイル時間 × 3」（250〜2000 ms）に伸ばす。約 2 MB の MML は字句解析＋コンパイルに約 0.6 秒かかるため、入力のたびに UI を止めない。再生・書き出し時は従来どおり即時コンパイル。
- **Worker の失敗**: Worker が起動できない／クラッシュした場合のみメインスレッドで1回だけ再実行する（タイムアウトとエンジン例外は再実行しても同じ結果になるため再実行しない）。
- **計測**（M シリーズ Mac、Node 22）: 16ch・12,154 ノートの SMF1 の読込＋変換＋再コンパイル＋照合 167 ms、生成 MML（471 KB）のコンパイル 63 ms、SMF 書き出し 15 ms。
- **ブラウザ**: Playwright の Chromium / Firefox / WebKit で同じ E2E（再生・シーク連打・音源切替中の再生・元 MIDI/MML 切替連打・Worker 失敗時の代替・大きな MML・SF2 ダウンロード失敗からの再試行）を実行。WebKit は Safari と同じエンジンだが Safari 本体ではない。
- テスト: `tests/e2e/stress.spec.ts`、`tests/engine/samples.test.ts`（全サンプルが診断なしでコンパイルできる）。

## D-020 PC-9801 PLAY（行番号形式）の変換で置いた仮定（Phase 6a）
意味が確定できない項目は次のように**仮定**して変換し、変換時に警告を出す。仮定が誤りと分かれば変換器だけを直す。
- `O4C` = MIDI 60（`O4A` = 440Hz の慣例）。
- `N0` = 休符、`N1` = `O1C`（= MIDI 24）。
- `^x` = 直前の音（または休符）に音長を足す。`&` の後が別の音高なら、前の音を隙間なく鳴らす（スラー相当）。
- 付点 2 個以上は「直前の加算分の半分を足す」（`..` = 1.75 倍）。
- 音長を省略した連符 `{…}` は現在の `L` を等分する。連符の中の個別の音長は無視する。端数の tick は先頭の音から 1 tick ずつ配分し、合計を正確に保つ。
- `Z`（例: `Z0,3`）は引数ごと読み飛ばす。`MB`/`MF` は音に関係しないため警告なしで無視する。`@W` は同じ長さの休符とする。
- 音量: `V` = round(x×127/15)、`@V` = そのまま。後に書いた方を使う。`Q` = round(x×100/8)%。
- テンポは最初に `T` を書いたパートを基準にし、他パートの食い違う値は無視して警告する（MML Studio のテンポは曲全体で共通）。
- FM 音色は名前の近い GM 音色へ置き換える（SPEC 付録 A）。番号と音色名の対応は未確認。パート 4〜6（SSG）の初期音色は `@81`。
- 中身が空のパート（`""`）はトラックを作らない。
- 入力の解析（行の形式）を先に全体で行い、その後でパートの MML を解釈する。そのため、行の形式エラーが MML の文字エラーより先に報告される。
- 出力は分母式（付点 1 個・`^` の連結を含む）で書けるときは分母式、書けないときだけ `%N`。元の行番号を行末コメントに残す。
- 検証: 実際の PC-9801 `PLAY` データ 2 曲（3 パート・242 音、2 パート・302 音）を手元で変換し、再コンパイル検証一致・Chrome で再生できることを確認した（他者のデータはリポジトリに含めない）。
- テスト: `tests/engine/dialect-pc98.test.ts`（L47〜L61）、`tests/e2e/dialect.spec.ts`。
