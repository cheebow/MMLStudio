# MML Studio — Web MML Player 開発仕様書

- **文書バージョン**: 1.2.0（他方言 MML の変換を追加）
- **策定日**: 2026-10-31
- **実装対象**: Web アプリケーション + 独立した TypeScript MML エンジン
- **実装担当**: Claude Code
- **仕様の優先順位**: 本書 > 本書内のコード例 > 参考サイトの記法。未記載のサクラ構文を推測で実装しない。

## 0. Claude Code への最重要指示

この仕様書を唯一の要件定義として、実際にブラウザで音が鳴るアプリを実装すること。**サクラMMLのコンパイラ・パーサー・再生ライブラリは絶対に使用しない。** MML の字句解析、構文解析、意味解析、トラックの時間管理、中間イベント生成、SMF（Standard MIDI File）書き出しと、**MIDI→MML の変換処理**は独自の TypeScript コードで実装する。MIDIのSMFバイナリ読み取りも独自実装する。

SoundFont の *音声合成* に限り、`spessasynth_lib` を使用してよい。同ライブラリの `Sequencer` で、**独自エンジンが生成した SMF** を再生する。こうすることで再生位置、一時停止、シーク、テンポイベントをブラウザの `setTimeout` の精度に依存させない。

**進め方**: Phase 0 → 1 → 2 → 3 → 4 → 5 の順に、各 Phase の自動テストと動作確認を終えてから次へ進む。仕様に矛盾を見つけた場合は仕様の整合性を優先して修正案と理由を `docs/DECISIONS.md` に記録する。未実装機能がある場合は、実装済みと表示しない。動作確認を行わずに「完成」と報告しない。

---

## 1. 目的・基本方針

### 1.1 目的

ブラウザのテキストエディタに MML（Music Macro Language）を入力して、その場で GM（General MIDI）相当の多彩な楽器音で演奏できる Web アプリを作る。さらに **ローカルMIDIファイルを開き、再生し、MMLへ変換して表示・編集・再生・保存できる**ようにする。

### 1.2 原則

1. **標準志向**: 歴史的な BASIC/MSX 系MMLなどで一般的な `cdefgab`, `r`, `o`, `l`, `>`, `<`, `t`, `v` を採用する。ただし MML には単一の公式共通規格はないため、本書が定義する「MML Studio 方言」を正確に公開する。
2. **限定的なサクラ風拡張**: `TR(n)` / `Track(n)`、`CH(n)` / `Channel(n)`、和音 `'ceg'4`、`Sub{...}`、`Time(小節:拍:tick)` と絶対tick音長 `%N` を採用する。これはサクラ完全互換を意味せず、意味・制限は本書で定義する。サクラの実装は一切取り込まない。
3. **責務の分離**: `MML → IR → 自作SMFライター → SoundFont` と `SMF → 自作MIDIリーダー → 正規化イベント → 自作MMLシリアライザー → MML` の2系統とし、双方をテストする。
4. **ブラウザ内完結**: サーバーサイドの変換処理、APIキー、ユーザ登録、楽曲アップロード、解析APIへの送信は不要。
5. **公開可能**: 静的ファイルを Vite でビルドし、GitHub Pages 等で HTTPS 公開できる。
6. **品質優先**: 音楽的な時間・音高・トラック管理をユニットテストで証明する。再生中の取りこぼしやノートの鳴りっぱなしを防ぐ。MIDI→MML変換時の情報損失は診断・比較できるようにする。

### 1.3 スコープ

**MVP（Phase 0〜3 の完了条件）**

- MML の入力、エラー表示、コンパイル、再生・一時停止・停止・シーク
- 1つの MML テキスト内に複数トラック／複数MIDIチャンネル
- GM 128 音色、チャンネル10のGMドラム、SoundFont切り替え（内蔵 + ローカルSF2）
- MML ファイルの読み込み／ダウンロード
- `.mid`（SMF Type 1）ダウンロード
- 代表的なサンプル MML と基本ヘルプ、音源読み込み状態表示
- 自動テスト、ビルド、実ブラウザでの再生確認

**初回公開後の必須機能（Phase 4）**: `.mid` / `.midi` のSMF 0/1インポート、元MIDIの直接再生、MIDI→MML変換、編集後のMML再生と保存、**「忠実度優先」「読みやすさ優先」**の変換モード、和音・`Sub{}`・`Time(...)`・tick指定音長の構文、基本CC/ピッチベンド。**Phase 4が終わるまでMIDIインポート機能を「完成」と呼ばない**。Phase 0〜3のMVPは従来どおり先に作る。

**対象外（将来機能）**: WAV書き出し、SF3のローカル読み込み、マクロ、繰り返し、連符、ストトン、日本語構文、`TrackSync`、任意の式評価、コード共有用バックエンド、楽譜表示、ピアノロール編集、外部 MIDI キーボード入出力、SMF Type 2とSMPTE時分割のMML変換、SysExの編集/再現。一般的なMIDI→MML変換の対象外イベントは詳細な警告を表示する。

---

## 2. 技術スタック

| 項目 | 採用技術 | 理由・制約 |
|---|---|---|
| 言語 | TypeScript (`strict: true`) | 型安全、エンジンの単体利用 |
| UI | React + Vite | 静的公開、軽量な構成 |
| MML エディタ | CodeMirror 6 | シンタックス色分け、診断位置の表示 |
| ユニットテスト | Vitest | パーサー・コンパイラ・SMFバイナリテスト |
| ブラウザE2E | Playwright | UI、読み込み、再生操作確認 |
| SoundFont 音源 | `spessasynth_lib` 4.4系 | SF2/GM音源、Web Audio / AudioWorklet |
| MIDI演奏 | `spessasynth_lib` の `Sequencer` | 自作SMFとインポート元SMFを音声合成エンジンへ供給 |
| MIDI読み取り・MML逆変換 | 独自TypeScript実装 | SMF0/1、running status、ノートペアリング、MML生成 |
| 標準音源 | GeneralUser GS v2.0.3 SF2 | GM対応、比較的軽量（メモリ約30.7MB） |
| デプロイ | GitHub Pages / 任意の静的ホスティング | HTTPS、APIサーバー不要 |

- 実装開始時に依存ライブラリの公式ドキュメントとインストール済み型定義を確認し、**動作確認した厳密な依存バージョンを lockfile に固定**する。2026-10-31時点で `spessasynth_lib` 4.4.2 の公開を確認済み。
- 音声合成には `spessasynth_lib` だけを使用する。MML解析に `sakuramml-*`, `picosakura` 等を追加してはいけない。
- 音声合成の内部実装まで自作する必要はない。
- 原則ローカル実行・開発では `npm install` → `npm run dev`、公開版は `npm run build`。

---

## 3. MML Studio v1 言語仕様（規範）

### 3.1 全般

- 文字コード: UTF-8。改行は LF / CRLF に対応。
- 英字コマンドは原則として大文字・小文字を区別しない。例: `o4`, `O4`, `Tempo(120)`。
- 空白、タブ、改行、セミコロン `;` はコマンド間の区切りとして無視する。
- コメント: `// 行末まで`、`/* ブロックコメント */`（入れ子不可）。文字列リテラルは MVP では使用しない。
- 音符は区切り文字なしで続けてよい: `cdefgab`。
- コマンド名は**最長一致**で解析する。`TR(1)`を `t` + `r` と誤認しない。
- 数値は原則 ASCII の10進非負整数。特別に指定がない限り小数や負数を認めない。
- すべての不正な文字、不正なコマンド、不正な範囲、未対応構文は **行・列・該当範囲付きコンパイルエラー** とする。黙って読み飛ばさない。
- デフォルトの状態はソースの先頭から始まる。どのトラックへも未編集状態のデフォルトが適用される。

### 3.2 基本コマンド一覧

| 記述 | 仕様 | 範囲・初期値 | 例 |
|---|---|---|---|
| `c d e f g a b` | ドレミファソラシ | MIDI音高0〜127 | `cdefgab` |
| `+`, `#`, `-` | 直前の音名に付く半音上げ／下げ（1個まで） | — | `c+`, `f#`, `b-` |
| `r` | 休符 | 音長指定可 | `r4`, `r8.` |
| `oN` | オクターブ番号 | 0〜9、初期値4 | `o5` |
| `>` / `<` | オクターブを +1 / -1 | 結果0〜9 | `>c`, `<g` |
| `lN` | 省略音長の指定 | N=1,2,4,8,16,32,64、初期値4 | `l8` |
| `lN.` | 付点付きの省略音長 | 付点は1個まで | `l8.` |
| `cN`, `dN` 等 | 個々の音符の長さ | 同上 | `c4d8` |
| `cN.` | 付点 | 1個まで | `c4.` |
| `tN` | テンポ（四分音符/分） | 20〜300、初期値120 | `t140` |
| `Tempo(N)` | `tN` の別表記 | 同上 | `Tempo(120)` |
| `vN` | Note On ベロシティ | 0〜127、初期値100 | `v96` |
| `qN` | ノート長に対するゲート率（%） | 0〜100、初期値90 | `q85` |
| `@N` | GM音色（1始まり） | 1〜128、初期値1 | `@49` |
| `nN` | MIDIノート番号の直接指定 | 0〜127 | `n60`, `n36` |
| `&` | **同じ音高**の連続音を1音としてつなぐ | 次節参照 | `c4&c4` |
| `^N` / `^N.` | 直前の音符に指定音長を加算して保持 | 次節参照 | `c4^8` |
| `TR(N)` / `Track(N)` | 現在のトラックを切り替える | 0〜32、初期値1 | `TR(2)` |
| `TR=N` | トラック切替の別表記 | 同上 | `TR=2` |
| `CH(N)` / `Channel(N)` | 現在のトラックのMIDIチャンネル指定 | 1〜16 | `CH(10)` |
| `CH=N` | チャンネルの別表記 | 同上 | `CH=10` |
| `'<notes>'[length]` | 同時発音する和音。閉じる引用符の直後に音長 | ノート名 / `nN`。次節 | `'ceg'4` |
| `Sub{...}` | 内部演奏後、元の演奏位置へ戻る | 入れ子最大8階層 | `Sub{c4 e4} g4` |
| `Time(M:B:S)` | 現トラックの演奏位置を絶対指定 | 小節/拍は1始まり、Sはtick | `Time(2:1:0)` |
| `c%N` / `r%N` / `n60%N` | 音長を絶対tickで指定 | N=1..2,000,000 | `c%372` |
| `l%N` | 省略音長の絶対tick指定 | 同上 | `l%240` |
| `q%N` | Note OnからNote Offまでの絶対tick | N=0..2,000,000 | `q%359` |
| `CC(C,V)` | MIDI Control Change | C,Vとも0..127 | `CC(64,127)` |
| `PB(N)` | MIDI Pitch Bend（中央0） | -8192..8191 | `PB(1024)` |
| `TempoUS(N)` | MIDIテンポをμs/4分音符で厳密指定 | 1..16,777,215 | `TempoUS(500001)` |

**Phase 0〜3では従来の基本構文を優先し、上表下段の和音・時間制御・MIDI逆変換用追加命令はPhase 4で実装する。** `q`、`v`、`t`、オクターブ番号などは各MML実装で意味が異なるため、サクラとの完全互換は目標としない。特にサクラの小文字 `t` は発音タイミング調整だが、**本仕様の小文字 `t` はテンポ**である。

### 3.3 音高とオクターブ

- `o4c` は **MIDIノート60（中央のC / C4）**、`o4a` は69（A4/440Hz）と定義する。
- `o5c` は72、`o3c` は48。
- 各音名の半音数: C=0, D=2, E=4, F=5, G=7, A=9, B=11。
- `pitch = 12 * (octave + 1) + semitone + accidental`。
- 0〜127を超える音はコンパイルエラー。自動折り返し・自動クリップしない。
- `n60` の音高はオクターブ状態に依存せず、音長はそのトラックのデフォルト `l` に従う。
- `<` `>` の意味は常に **`>` が高く、`<` が低い** 方向で固定する。

### 3.4 音長・付点・タイ

- PPQは **480 ticks / 4分音符** に固定。全音符1920、二分音符960、四分音符480、八分音符240、16分音符120、32分音符60、64分音符30 ticks。
- 付点（1個まで）は基準音長 × 1.5。例: `c4.`=720 ticks、`r8.`=360 ticks。
- `l8` の後の `c` は240 ticks。`l8.` の後の `c` は360 ticks。個別に `c4` と指定した場合、その音だけ480 ticks。
- 休符はトラック時刻だけを進め、発音イベントを作らない。
- `c4^8` は MIDI音高Cを **720 ticks** 保持する1音符。`^`の右には必ず音長（必要なら付点）が必要。連結 `c4^8^16` を許可する。
- `c4&c4` は同じ音高のノートを連結して**960 ticks の1音符**にする。`c4&d4` はエラー。休符やトラック切替をまたいだ `&` は不可。
- タイまたは音長加算で連結されたノートは**最初のノートのベロシティとゲート率を保持**し、まとまった音長に対して1回だけゲート率を計算する。
- ノート長 `durationTicks` と発音長 `gateTicks` は別々。`gateTicks = round(durationTicks * q / 100)`。`q>0` なら最低1tick、`q=0` または `v=0` は無音（ただし時間は進む）。`q=100` は音符境界まで発音する。
- MIDI生成時、同時刻の同一チャンネル・同一音高については Note Off を Note On より先に記録して再発音を保証する。
- 同一チャンネル・同一音高の**時間的な重なり**（タイ以外）はエラー。異なる音高であれば同時発音可能。MIDIインポートで該当する場合は元MIDIを保持して直接再生可能にし、MML変換では警告付きで前の音のゲートを短縮する（黙って衝突を見逃さない）。

### 3.5 トラックとMIDIチャンネル

**トラック**は楽曲の独立した時間軸、**MIDIチャンネル**は音源の制御先。両者は異なる概念。

- トラック番号: `0..32`。`TR(0)` はメタ情報・テンポイベント用の**コンダクタートラック**。TR(0)内の音符、休符、`@`, `v`, `q`, `o`, `l`, `CH`, `CC`, `PB` はエラー。`Tempo` と `Time(...)`（Phase 4）が使える。
- 演奏用トラック: `1..32`。トラックごとに `cursorTick`, `octave`, `defaultLength`, `velocity`, `gatePercent`, `program`, `channel` を持つ。最初に切り替えたときに初期化し、別トラックから戻った場合は状態を復元する。
- `TR(2)` に切り替えてもトラック1の `cursorTick` は進まない。複数パートはそれぞれ tick 0 からスタートする。
- MIDIチャンネルは1〜16、**10はGMドラム**。内部MIDIメッセージでは0〜15に変換する。
- `TR(1..9)` の初期チャンネルは1..9、`TR(10..15)` の初期チャンネルは11..16。`TR(16..32)` は自動割当なしで、最初の演奏イベントより前に `CH(N)` が必要。
- `CH(N)` は、そのトラックの**最初の発音イベントより前にのみ設定可能**。途中変更はエラー（予測不能なチャンネル共有を防ぐ）。
- **異なる演奏トラック同士の同一MIDIチャンネル共有は禁止**（Phase 4でも維持）。コンパイル時に使用チャンネル重複を検出し、行番号付きでエラーにする。最大16チャンネル（ドラム含む）で同時演奏可能。
- `@N` は当該チャンネルの GM Bank 0 / Program (N-1) として扱う。トラック内での途中音色変更は可能。Program Change は当該トラックの現在時刻に配置する。
- `CH(10)` ではノート番号はGMパーカッションマップ（例: `n36`=Bass Drum、`n38`=Acoustic Snare、`n42`=Closed Hi-Hat）。`@N` はドラムチャンネルでは非対応エラーとし、プリセットキット変更は将来機能とする。
- ドラムに `c` 等を記述した場合も通常の MIDI音高番号として発音されるが、**実用上は `n36`, `n38` の使用を推奨**する。`o4c` が「ド」ではなくノート60のパーカッションに割り当てられることをヘルプに明記。
- 現行 SoundFont がGMバンク・キットを持たない場合は、指定音色での鳴り方を保証できないことをUIで通知する。

### 3.6 テンポ（楽曲共通）

- `tN` / `Tempo(N)` は**トラックローカルではなく楽曲全体のテンポ**を変更する。トラック内の現在 tick にテンポイベントを追加する。
- ソース先頭で `TR(0) t120` と書くスタイルを推奨するが、`TR(1) t120` も有効にする。
- 明示的なテンポが一つも無ければ tick 0 のテンポを120BPMとする。tick0に明示的なテンポがあればそれを優先し、デフォルト120は別イベントとして生成しない。
- **同じtickで異なる明示的BPMが複数指定されたらエラー**（同じ値は統合）。MMLソースの出現順で一方を勝手に上書きしない。
- 同一tickの複数トラックで異なるBPMが設定されても、イベントが競合するだけでトラックごとのテンポがあるわけではない。
- tickから秒への換算はテンポマップによる区分積分を行う。例: `t120 c4 t60 c4` は500ms + 1000ms = 約1.5秒。

### 3.7 和音・時間制御・MIDI逆変換のための拡張（Phase 4）

**和音 `'<notes>'<length>`**

- `'ceg'4` は C/E/G の3音が同時刻に開始し、記譜音長480tickを共有する。省略時は `l` を使う。`'ceg'8.` と `'n60 n64 n67'%480` も有効。
- 引用符内には `cdefgab`、臨時記号、`n60` などの絶対音高、空白、`<` `>` を許可する。`<` `>` は**和音の内部だけで一時的に有効**で、終了後の外側のオクターブは変えない。
- 個々の構成音に別の音長や`v`・`q`を付けることはできない。和音全体で同じduration/gate/velocityを共有する。異なる場合は `Sub{}`、`Time(...)`、別ノートへ分割する。
- 和音が占めるトラック時間は最大音長ではなく**指定された共通音長1つ分**であり、和音音数分だけ進まない。2音以上必須、同一音高の重複はエラー。`'` は引用符であって通常の文字列ではない。

**`Sub{...}` / `Time(M:B:S)`**

- `Sub{...}` は `{}` 内を現在時刻から実行し、**終了後は開始時のcursorTickだけ戻す**。オクターブ、`l`、`v`、`q`、音色の変更は内側で行ったものが外側に残る（意図した意味を固定するためテストする）。`TR` / `CH` / `Tempo` / `Time` は `Sub` 内では禁止。ネストは最大8階層。
- `Time(M:B:S)` は現在トラックの**絶対時刻へ移動**。`M>=1`、`B=1..4`、`S=0..479`。定義式は `tick = ((M-1)*4 + (B-1))*480 + S`。**常に4/4基準の座標**で、MIDIに元々記録された拍子とは独立（拍子メタイベントは後述のインポート警告の対象）。前方移動・巻き戻しの両方を認める。
- `TR(0)` における `Time` はコンダクタートラックの時刻を変え、楽曲途中の `Tempo` 指定を可能にする。再度 `TR(0)` に戻ってもその位置は保持する。
- `c%N`, `r%N`, `n60%N`, `l%N`, `'ceg'%N` は**480 PPQでの絶対tick音長**を表す。`%N` と `4.` 等の分母式は併用不可。`q%N` は発音長の絶対tick指定で、`qN`（%比率）とはモードが切り替わる。`q%N` は各音符の記譜長を超えてもよいが、同一ch/pitch重複の規則は守る。`q%0` は無音。
- `Time` で出発点を繰り返し指定して個々のノートを並べれば、単純な和音で表せない音長・ベロシティ・開始時刻の違いも表せる。追加の独自命令 `At(...)` は作らない。

**正確なMIDIテンポ（Phase 4）**

- `TempoUS(N)` は **Nマイクロ秒/4分音符** のSMF tempo event（FF 51）を表す。一般的な作曲では `t120` / `Tempo(120)` を使い、MIDIインポートの厳密変換時のみ `TempoUS` を優先する。トラック0または演奏トラックの現在時刻に配置できる。`t` と `TempoUS` が同一tickで異なるテンポを指定した場合はコンフリクトエラー。`TempoEvent` は μs値を正本とし、BPMは表示用に換算する。

**MIDIコントロール（必要最小限）**

- `CC(number,value)` はコントロールチェンジ、`PB(signed14bit)` はピッチベンドを現トラックの現在tickに追加する。双方とも**トラック時間を進めない**。MIDI上の発音表現とペダルCC64、音量CC7、パンCC10、エクスプレッションCC11などを保持する用途。
- 範囲外値はエラー。`CC(0,...)`/`CC(32,...)`のバンク選択やRPN等は**そのままMIDIに書き出す**が、SoundFontが指定バンクを提供するかは保証しない。SysEx、チャネルアフタータッチ、ポリフォニックアフタータッチは当面MML化しない。

### 3.8 サポートしない記法

- `[]` ループ、`{}` 連符、サクラの変数・マクロ・ストトン・式評価は未実装エラー。**「サクラ完全互換」と表示しない。**
- `&` による異音高スラーは未対応。同音高タイのみ。
- `t` の意味、`q`/`v` の範囲、`o` のMIDI音高対応、4/4固定の`Time`座標はヘルプとREADMEに掲載する。

### 3.9 ミニ文法（概略 EBNF）

```ebnf
program          = { separator | comment | command } ;
command          = track | channel | tempo | octave | octaveShift
                 | defaultLength | velocity | gate | programChange
                 | note | rest | absoluteNote | chord | sub | timePosition
                 | cc | pitchBend ;
track            = ("TR" | "Track"), "(", integer, ")"
                 | "TR", "=", integer ;
channel          = ("CH" | "Channel"), "(", integer, ")"
                 | "CH", "=", integer ;
tempo            = "t", integer | "Tempo", "(", integer, ")"
                 | "TempoUS", "(", integer, ")" ;
octave           = "o", integer ;
octaveShift      = ">" | "<" ;
defaultLength    = "l", (lengthSpec | tickLength) ;
velocity         = "v", integer ;
gate             = "q", (integer | tickLength) ;
programChange    = "@", integer ;
note             = noteName, [accidental], [lengthSpec | tickLength], { "^", lengthSpec },
                   [ "&", noteName, [accidental], [lengthSpec], { "^", lengthSpec } ] ;
rest             = "r", [lengthSpec | tickLength] ;
absoluteNote     = "n", integer, [lengthSpec | tickLength] ;
chord            = "'", { noteName, [accidental] | "n", integer | ">" | "<" | separator },
                   "'", [lengthSpec | tickLength] ;
sub              = "Sub", "{", { command | separator | comment }, "}" ;
timePosition     = "Time", "(", integer, ":", integer, ":", integer, ")" ;
cc               = "CC", "(", integer, ",", integer, ")" ;
pitchBend        = "PB", "(", ["-"], integer, ")" ;
tickLength       = "%", integer ;
noteName         = "c" | "d" | "e" | "f" | "g" | "a" | "b" ;
accidental       = "+" | "#" | "-" ;
lengthSpec       = ("1" | "2" | "4" | "8" | "16" | "32" | "64"), ["."] ;
integer          = digit, { digit } ;
separator        = space | tab | newline | ";" ;
comment          = "//", { notNewline } | "/*", { anyCharacter }, "*/" ;
```

**注**: 上記は概略。`'...'`/`Sub{}`/`Time(...)`/`%N`/`CC`/`PB`/`TempoUS`はPhase 4で有効化し、基礎MML実装を優先する。`&` の連結は複数回許可し、途中の明示音長がない場合は既定 `l` を使う。`nN` の音長は基本実装では既定 `l` のみ（例 `n36`）、Phase 4では `n60%240` などの明示tick指定も受け付ける。Lexer/Parserはソース位置を保持し、`c4^8` や `c4&c4` を正しい1音符に正規化する。

---

## 4. 中間表現（IR）と独立エンジンAPI

### 4.1 型の例

```ts
export type DiagnosticSeverity = 'error' | 'warning';
export interface SourceSpan {
  startOffset: number; endOffset: number; // UTF-16 code unit offset
  startLine: number; startColumn: number; // 1-based
  endLine: number; endColumn: number;     // 1-based
}
export interface Diagnostic {
  code: string; severity: DiagnosticSeverity;
  message: string; span: SourceSpan;
}
export interface NoteEvent {
  kind: 'note';
  track: number; channel: number; pitch: number; velocity: number;
  startTick: number; durationTicks: number; gateTicks: number;
  source: SourceSpan;
}
export interface ProgramEvent {
  kind: 'program'; track: number; channel: number;
  tick: number; program: number; // 0..127 (MIDI value)
  source: SourceSpan;
}
export interface TempoEvent {
  kind: 'tempo'; tick: number; bpm: number;
  microsecondsPerQuarter: number; // SMFの正確なテンポ値を正本とする
  source?: SourceSpan;
}
export interface ControlEvent {
  kind: 'cc'; track: number; channel: number;
  tick: number; controller: number; value: number; source: SourceSpan;
}
export interface PitchBendEvent {
  kind: 'pitchbend'; track: number; channel: number;
  tick: number; value: number; // -8192..8191, center=0
  source: SourceSpan;
}
export interface CompiledSong {
  ppq: 480;
  tracks: Array<{ number: number; channel: number; events: Array<NoteEvent | ProgramEvent | ControlEvent | PitchBendEvent> }>;
  tempoMap: TempoEvent[];
  endTick: number;
  diagnostics: Diagnostic[]; // warnings only on success
}
export type CompileResult =
  | { ok: true; song: CompiledSong; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
export function compileMml(source: string): CompileResult;
export function writeSmf(song: CompiledSong): Uint8Array;
```

- `compileMml` はDOM、AudioContext、ネットワーク、音源ライブラリに依存してはいけない。純粋な同期関数とする。
- 必須パイプライン: `Tokenizer → Parser(AST/Commands) → Semantic Compiler(TrackState/IR) → SMF Writer`。
- トラック状態は`Map<number, TrackState>`で管理し、すべてのイベントのtickは非負整数。
- 複数回のコンパイルで同じ入力から必ず同一イベント列と同一SMFバイト列を出す（決定的な並べ替え）。
- ソース範囲に基づいてエディタに構文エラー位置をマーカー表示する。
- 一度に可能なMML入力サイズは最大 **2 MiB**（MIDI変換結果を含む）、最大 **100,000 音符イベント**、最大 **32 演奏トラック**、曲長は最大 **2,000,000 ticks**。超過は明確なコンパイルエラーで返し、無限ループやフリーズを防止。

### 4.2 SMF ライター

- **独自実装**。MML → MIDI 部分に外部のMMLコンパイラを利用しない。
- SMF Type 1 / PPQ 480 / Big Endian / VLQ差分時刻を正しく生成する。
- `MThd` ヘッダーと `MTrk` チャンク。メタトラック0へテンポイベント `FF 51 03` を配置し、`TempoUS` 指定時はμs値を丸めずそのまま書く。初期拍子 `FF 58 04` は4/4、24 MIDI clocks/beat、8 32nd notes/quarter とする。
- 各演奏トラックは1本の MTrk に対応。Program Change (0xCn), Note On (0x9n), Note Off (0x8n)、Control Change (0xBn)、Pitch Bend (0xEn) を出力。ピッチベンドは value+8192 の14bit値をLSB/MSBに分解する。プログラム番号・チャンネル番号は0始まりに変換。
- 明示 `@` が無い演奏トラックでも、tick 0 に Program Change 0（GM Piano）を生成する。ただしCH10のドラムには送らない。
- すべてのトラック末尾に `FF 2F 00` を含める。曲の長さを示すため、全体終端tickは**各トラックの最後のノートの**記譜上の終了時刻・実Note Off tick・CC/Program/PBイベント時刻**の最大値を考慮する（後半の長い発音がEOTで切れないようにする）。
- 同じ tick のイベント順序は **Note Off → CC/Pitch Bend/Program Change（元のソース順を安定保存）→ Note On**。メタイベントは先に出力してよい。トラック内の元のソース位置で安定ソートする。
- 1つのチャンネルの同じピッチで同時に発音中の重複ノートを禁止する（前述）。
- 変換後の MIDI を第三者のSMFパーサー、または検証用の独立コードで読み直し、イベント値とトラック数・テンポ・時刻を検証する。

### 4.3 tick → 実時間

- 時間管理の正本はtick。UI表示用に `ticksToSeconds(tick, tempoMap)` を実装する。
- テンポ変更後のイベントを正しく積算する。曲長は実発音が終わった時刻ではなく、楽曲内の最終ノートの記譜終了tick（休符終端を含める場合はそのトラックのcursorTick）を基準にする。
- 再生中の現在時刻・シークは、SpessaSynth Sequencerの現在時刻と同期する。表示更新タイマーはUI用途のみに使用し、音符スケジューリングには使用しない。

---

### 4.4 MIDI→MMLインポート・シリアライザー（Phase 4、必須）

#### 4.4.1 入力、制限、責務

- ブラウザの File API でローカル `.mid` / `.midi`（内容がSMFなら拡張子不問でも可）を読み、**サーバーへ送信しない**。
- **自作 SMF Reader** によってSMF Format 0 / Format 1、PPQ時間分割、MTrk、VLQ、running status、各種チャンネルイベント、テンポ（0x51）、拍子（0x58）、トラック名（0x03）、EOT（0x2F）、SysExのスキップを扱う。**Format 2 とSMPTE time divisionはMML変換非対応**として明示的に通知する。
- SMF0はチャンネルごとに、SMF1は**元のMTrk番号とチャンネル番号の組を一度解析し、同一チャンネルの複数MTrkをマージ**して、最終的にチャンネルごと1つのMML演奏トラックへ配置する。元のトラック名やマージ元はコメント/インポート詳細に残す。TR番号は使用するMIDIチャンネル番号（1..16）に固定し、各トラック冒頭に `CH(N)` を明示する。ドラムは必ず `CH(10)`。
- MIDIの元PPQから内部480 PPQへ絶対tickで変換し、**各イベントを個別に最近接整数tickへ丸める**。丸めによる最大誤差をレポートに記録し、Note OffがNote On以前になる場合は最低1tickへ補正し警告する。元PPQの値を表示する。
- 最大読み込みサイズ **20 MiB**、最大 **300,000 MIDIイベント**、最大 **100,000 note-on**。MMLの2MiB/2,000,000tick上限を超える場合は**MML変換を中止して明示**し、元MIDI再生を可能な範囲で維持する。巨大ファイルでメインスレッドを固めないよう、Reader/変換はWeb Workerに切り出す（Web Worker内でもサイズ・イベント数上限を厳守）。
- 不正なVLQ、chunk長、running status、未終端ノート、無効データは**位置/トラック付きエラーまたは警告**を出す。破損SMFを部分的に正常扱いして再生/保存しない。未知のメタは安全にスキップして警告する。

#### 4.4.2 ノートとイベントの復元

- `noteOn(velocity>0)` を開始、`noteOff` および `noteOn(velocity=0)` を終了としてペアリングする。キーは**チャンネル + ピッチ**。同一ピッチが同時に重なって現れた場合はノートの対応が曖昧なので警告を出し、変換側では前の音のゲートを次の音の発音直前まで短縮し、必要に応じて分割する。元MIDI直接再生には介入しない。
- ノートには `startTick`、`noteOffTick`、`velocity`、`channel`、`program`を保持する。**ゲートは実際のMIDI Note Off時刻**とし、サステインペダルの聴感上の余韻は `CC(64,V)` の保存によって再現する（ノート長に勝手に吸収しない）。
- Tempo Mapはチャンネルを問わず全体で統合。同tickに異なるテンポがあればMIDI内のトラック順/イベント順で最後を採用して警告する。変換MMLではコンダクター`TR(0)` + `Time(...)` + `TempoUS(...)` として出力し、MMLのテンポ競合を起こさない。
- Program Change、CC、Pitch Bendを時刻付きで保持する。音色指定はMML上 `@1..128`、ドラムCh10は音程そのものを `n36` 等で表現する。GMにないBank SelectやSysEx依存音色は**音源依存として警告**する。
- 原ファイルの拍子（time signature）、キー、歌詞、マーカー、SysEx、アフタータッチなどはMML音符列としては保持しない（音への影響があり得るイベントの欠落を一覧表示）。**`Time(M:B:S)` のM/Bは常に固定4/4座標**であり、原曲の拍子と一致するとは限らない。将来拡張候補としてメタ保存用IRを分離する。

#### 4.4.3 MIDI→MML変換の2モード

**A. 忠実度優先（初期選択）**

1. 音高・発音開始tick・実Note Off tick・ベロシティ・Program・**TempoUSのμs値**・CC・Pitch Bendを可能な限り維持する。
2. 同時刻、同音長、同ゲート、同velocity、同チャンネルの2音以上は**和音**としてまとめ、`'ceg'4` や `'n60 n64 n67'%480` を出力する。複雑な音域・臨時記号がある場合は `nN` を優先して正確性を担保する。
3. それ以外はイベントごとに `Time(M:B:S)` で開始位置を合わせ、`vN`、`q%N`、`n<note>%<ticks>` 等で書き出す。`Sub{...}` は、読みやすさを改善しつつ**完全に同じイベントを作れる場合のみ**使用する。`TR/CH`の追加チャンネルや無意味な`At`独自コマンドは用いない。
4. Program/CC/PBは必要な直前tickに `Time(...)` とともに出力する。コマンドとNote Onが同tickの場合はSMF writerの優先順に合わせる。発音途中でのProgram変更など、SoundFont差異は比較レポートで示す。
5. 生成したMMLを**自作 `compileMml` で再コンパイル**し、元の正規化MIDIイベントと照合する。ノートの音高/チャンネル/ベロシティと、丸めた開始tick/Note Off tick、テンポ/音色/CC/PBの一致を検証。なお、原MIDIに明示されていない既定120BPM/GM Pianoは**意味的な初期状態として正規化**し、writerが追加した冗長なtick0イベントの有無だけで不一致にしない。比較に失敗した変換テキストを「忠実変換成功」として表示・保存させない。原MIDIはいつでも直接再生できる。

**B. 読みやすさ優先**

1. デフォルト**1/16音符=120tick**グリッドで開始位置と記譜音長を量子化する。UIで `1/8`・`1/16`・`1/32` の量子化単位を選択可能とする。
2. 可能なら分母式の音長 `4`, `8`, `16`、付点、通常の休符、同時発音和音を使用し、可読性を高める。安定したオクターブには `oN` と音名を使う。**複雑に重なる声部は `Sub{}`/`Time(...)`、同一チャンネル内の異声部を混在させてよい。**
3. 量子化した結果、元のMIDIと発音時刻・音長に差が出ることをUIに明示する。ノート脱落・音程変更はしない。量子化後同一ch/pitch衝突が起きる場合は局所的にtick指定を残すか、警告して忠実モードへフォールバックする。
4. テンポ・音色・ドラム指定は保持。CC/PBの多い曲ではイベントを簡略化する設定を用意してもよいが、**削除数と種類を警告**する。初期状態では削除しない。

#### 4.4.4 再生と比較、失敗時の扱い

- MIDIを読み込んだら、**元MIDIをそのままSequencerで再生する「元MIDI」** と、**変換MML→独自SMF writer→Sequencerで再生する「MML」** を切り替える。**MMLタブには必ず生成された編集可能なテキストを表示**する。
- 変換モード/量子化単位を切り替えると再変換する。編集中の場合は上書き確認し、原MIDI/原MMLのバックアップを保持する。
- `MML`再生はその時点のエディタ内容を再コンパイルする。`元MIDI`再生はユーザーによるMML変更に影響されない。標準SoundFont/ローカルSF2は両再生経路で共通。
- **MMLを編集・保存したい場合、MMLが真の成果物**。元MIDIの隠しイベントに頼ってMML再生させない。表現できないMIDI情報はインポート詳細の警告へ明示し、元ファイル直接再生で聴き比べられるようにする。
- インポート診断に、元PPQ、トラック/チャンネル数、ノート数、量子化・丸め誤差、変換できなかったイベント、原音との差分（数・最大tick差）を表示する。

#### 4.4.5 公開API（形の例）

```ts
export interface MidiImportOptions {
  mode: 'fidelity' | 'readable';
  quantize?: '1/8' | '1/16' | '1/32';
}
export interface MidiImportSummary {
  originalFormat: 0 | 1;
  originalPpq: number;
  sourceTracks: number;
  sourceChannels: number;
  noteCount: number;
  roundingMaxErrorTicks: number;
  warnings: string[];
}
export type MidiImportResult =
  | { ok: true; mml: string; summary: MidiImportSummary; originalSmf: Uint8Array }
  | { ok: false; diagnostics: Diagnostic[]; originalSmf?: Uint8Array };
export function readSmf(bytes: Uint8Array): MidiReadResult;
export function midiToMml(parsed: ParsedMidi, options: MidiImportOptions): MidiImportResult;
export function compareMidiEvents(original: ParsedMidi, compiled: CompiledSong): RoundTripReport;
```

- `MidiReadResult` / `ParsedMidi` / `RoundTripReport` は必要な型をエンジン内部で定義し、テストから利用できるよう export する。**SMF reader・変換器は `src/engine/` 以下の独立モジュール**とする。
- 原MIDIの再生にライブラリのSequencerを使ってよいが、MMLの字句解析・変換・検証に外部MMLエンジンを使わない。

---

### 4.5 他方言 MML の変換（Phase 6）

##### 4.5.1 目的と原則

- 他の MML 方言で書かれたテキストを貼り付け、**MML Studio の MML テキストへ変換**してエディタに入れる。
- **MML Studio の言語（3 章）は変更しない**。方言の構文は変換器の中だけで扱い、出力は常に 3 章の構文で書く（CLAUDE.md 6 の「独自方言を増やさない」を守る）。
- 変換器は `src/engine/dialects/` の**独自 TypeScript** とし、DOM・音声ライブラリに依存しない。他の MML 処理系のコードは使わない。
- 変換できない命令・推測で変換した命令は**黙って捨てず**、元テキストの行・列付きの警告にする（4.4 の MIDI インポートと同じ方針）。
- MML/方言テキストはブラウザ内だけで処理し、外部へ送らない。
- 対象方言は段階的に追加する。**Phase 6a: PC-9801 `PLAY` 文（下記の行番号形式）**、Phase 6b: picosakura（別途追記）。

##### 4.5.2 公開 API（形の例）

```ts
export type DialectId = 'pc98-play';
export interface DialectSong { index: number; title?: string; startLine: number; parts: number }
export interface DialectWarning { code: string; message: string; line: number; column: number; count?: number }
export type DialectConvertResult =
  | { ok: true; mml: string; warnings: DialectWarning[]; summary: { dialect: DialectId; parts: number; notes: number; verified: boolean } }
  | { ok: false; errors: DialectWarning[] };
export function listDialectSongs(text: string, dialect: DialectId): DialectSong[];
export function convertDialect(text: string, dialect: DialectId, options?: { songIndex?: number }): DialectConvertResult;
```

- 変換器は出力 MML を `compileMml` で**再コンパイル**し、エラーが無いこと、および変換器自身が求めた音符列（音高・開始 tick・発音長・ベロシティ・チャンネル）と一致することを確認する（4.4.3 A-5 と同じ考え方）。一致しなければ `ok: false`。
- 入力の上限は 2 MiB。出力が 3 章・4.1 の上限（2 MiB、100,000 音符、2,000,000 tick）を超える場合は変換を中止して理由を示す。

##### 4.5.3 PC-9801 `PLAY` 文（行番号形式）— 入力の形

対象は次のような行の並び。

```text
"0101","テスト曲",3,3,6
01 "MBQ7L8@13T140@V110Z0,3","MBQ7L8@13T140@V110Z0,3","MBL8@46T140@V115"
02 "O5C..C32DEFGAB","O4C2E2","R1"
03 "O5C1","O4C1","R1"
```

| 行の種類 | 判定 | 扱い |
|---|---|---|
| 見出し行 | 引用符付きの文字列 2 つ＋数値 3 つ（`"ID","曲名",n,n,n`） | 曲の区切り。**曲名だけ**コメントに残す。数値は使わない |
| 演奏行 | `行番号` ＋ 引用符付き文字列 1〜6 個をカンマ区切り。`行番号 PLAY "…","…"` の形も受け付ける | i 番目の文字列 = パート i |
| 空行・その他 | — | 空行は無視。それ以外は行番号付きエラー |

- **パートの連結**: 各パートの文字列を**行番号の順**に連結し、1 本の MML とみなす（BASIC の `PLAY` はパートごとのキューに積まれ、O/L/V/Q/@/T の状態は行をまたいで続く）。行番号が昇順でない場合は警告して出現順に並べる。
- 1 つの貼り付けに複数の曲（見出し行が複数）があるときは、曲の一覧を返し、UI で選んだ 1 曲を変換する。見出し行が無ければ全体を 1 曲とみなす。
- 文字列内の**空白は無視**する（`A #` = `A#`、`< A>` = `<A>`）。英字の大文字・小文字は区別しない。
- BASIC の文字列変数（`A$` の連結など）、`GOTO`・`FOR` などのプログラム構造は対象外とし、エラーにする。

##### 4.5.4 PC-9801 `PLAY` 文 — 命令の変換表

「確度」列: ◎ = 確定、△ = 推定（変換時に情報警告を出す）。

| 命令 | 意味・範囲・初期値 | 確度 | MML Studio への変換 |
|---|---|---|---|
| `C D E F G A B` | 音符。`O4`/`L4` が初期値 | ◎ | 音名。**`O4C` = MIDI 60 とみなす**（未確認。実機で O4A = 440Hz の慣例に合わせる） |
| `+` `#` / `-` | 半音上げ／下げ | ◎ | `+` / `-` |
| `.`（複数可） | 付点。1 個で 1.5 倍 | ◎（複数は△） | 2 個目以降は直前の加算分の半分を足す（`..` = 1.75 倍）。分母式（付点 1 個・`^` の連結を含む、例: `8.^32`）で表せればそれを使い、表せなければ `%N` |
| `Lx` | 既定の音長、1〜64、初期値 `L4` | ◎ | 1,2,4,8,16,32,64 は `lx`。それ以外（`L3`, `L6`, `L12` など）は `l%N`（N = 1920/x、割り切れなければ四捨五入して誤差を警告） |
| 音長 `x`（音符・休符の後） | 1〜64 | ◎ | 上と同じ規則 |
| `Rx` | 休符 | ◎ | `r` |
| `Ox` | オクターブ 1〜8、初期値 `O4` | ◎ | `ox` |
| `>` / `<` | オクターブ +1 / −1 | ◎ | `>` / `<`（向きは同じ） |
| `Nx` | 音高を番号で指定、0〜96 | ◎（番号の基準は未確認） | **未確認のため**警告付きで変換（`N0` = 休符、`N1` = `O1C` と仮定）。仮定は DECISIONS に記録 |
| `&` | 前後の音をつなぐ | ◎ | 同じ音高ならタイ `&`。異なる音高は 2 音のまま、前の音を `q100` 相当で隙間なく書き、警告 |
| `^x` | 直前の音への音長の加算 | △ | 直前の音に音長を足す（MML Studio の `^`）。情報警告 |
| `{…}x` | 連符: x 分音符を { } 内の音数で等分 | ◎（x 省略時は未確認） | 各音を `%N` で書く。端数は合計が x 分音符ちょうどになるよう先頭から 1 tick ずつ配分。x 省略時は現在の `L`（未確認・警告）。{ } 内の個別音長は無視して警告 |
| `Tx` | テンポ 32〜255、初期値 `T120` | ◎（4 分音符/分） | `TR(0)` に `Time(...)` 付きの `Tempo(x)`。テンポは楽曲全体共通（3.6）なので、**最初にテンポを書いたパートを基準**にし、他のパートの同じ位置・同じ値は統合、異なる値は無視して警告 |
| `Vx` | 音量 0〜15、初期値 `V8` | ◎ | `v` = round(x × 127 / 15)。`V0` は無音 |
| `@Vx` | 音量 0〜127 | ◎ | `v` = x。`V` と `@V` は**後に書いた方**を使う（機種依存の注記あり） |
| `Qx` | 音の長さの割合 1〜8、初期値 `Q8` | ◎ | `q` = round(x × 100 / 8)（`Q8` = `q100`、`Q7` = `q88`） |
| `@x` | FM 音色 0〜81、初期値 `@0` | ◎（番号表は△） | 付録 A の対応表で GM 音色 `@1`〜`@128` に置き換える。音色そのものは再現できない（情報警告は曲ごとに 1 回） |
| `MB` / `MF` | バックグラウンド／フォアグラウンド演奏 | ◎ | 音に影響しないため無視（警告なし） |
| `Sx` `Mx` | SSG エンベロープ | ◎ | 変換しない（警告・件数） |
| `Yr,d` | OPN レジスタ書き込み | ◎ | 変換しない（警告・件数） |
| `Z…`（例: `Z0,3`） | 音に関係しない設定とみなす | △ | 引数ごと読み飛ばして警告 |
| `@M` `@L` `@R` | 出力の左右 | ◎ | 変換しない（警告）。将来 `CC(10,…)` への変換を検討 |
| `@Wx` | 状態を維持 | ◎（意味の詳細は未確認） | 長さ x の休符とみなし、警告 |
| その他の文字 | — | — | 行・列付きエラー |

**チャンネルと音色の割り当て**

- パート i（1〜6）→ `TR(i) CH(i)`。CH10（GM ドラム）は使わない。
- パート 1〜3 を FM、4〜6 を SSG とみなす。SSG パートは `@81`（Lead 1 square）を初期音色とし、`@x` があれば FM と同じ表で置き換える。
- 各トラックの冒頭に、元の音色名をコメントで残す（例: `// @46 HARPSIC → @7 Harpsichord`）。

##### 4.5.5 出力 MML の書式

- 先頭に `// PC-9801 PLAY から変換: <曲名>` と、変換時の注意（音色・エンベロープは再現しない等）をコメントで書く。
- `TR(0)` にテンポ（`Time(...) Tempo(N)`）、`TR(1)`〜にパート。元の行番号を行コメント（`// 02`）として残し、元データと対応付けられるようにする。
- 可能な限り音名・`o`・`l`・分母式の音長で書き、表せない長さだけ `%N` を使う。

##### 4.5.6 UI

- ヘッダーに「他の MML から変換」を追加。ダイアログで次を行う。
  1. テキストを貼り付ける（`.txt` ファイルの読み込みも可）
  2. 方言を選ぶ（自動判定は候補の提示だけにし、ユーザーが確定する）
  3. 複数曲なら曲を選ぶ
  4. 変換結果のプレビュー、警告一覧（行・列・件数）、検証結果を確認する
  5. 「エディタに反映」。編集中なら確認し、反映前の内容を「変換前の MML に戻す」で復元できるようにする
- 変換はメインスレッドで行ってよい（2 MiB 上限内で十分に速いことを計測で確認する）。遅い場合は 4.4 の Worker を流用する。

---

## 5. SoundFont および再生エンジン

### 5.1 アーキテクチャ

```text
ローカル MIDI(.mid) ─→ 自作SMF Reader ─→ 自作MMLシリアライザー ─→ MMLエディタ
       │                                                          ↓
       └────────────────────→ 元MIDI直接再生（比較用）          MML テキスト
                                                                  ↓
                               独自 Tokenizer / Parser / Semantic Compiler
                                                                  ↓
                              CompiledSong（notes・tempo・program・CC・PB）
    ├─→ 独自 SMF Writer ─→ .mid ダウンロード
    │                      ↓
    │               SpessaSynth Sequencer
    │                      ↓
    │              WorkletSynthesizer + SoundFont
    │                      ↓
    └─→ UI時刻/診断      Web Audio → スピーカー
```

**重要**: SpessaSynth はMMLを知らない構成にする。MML側のデータ構造をSpessaSynthの型に漏らさず、薄い `SoundFontPlaybackAdapter` に閉じ込める。

### 5.2 標準音源とライセンス

- **GeneralUser GS v2.0.3** を標準GM/GS対応SF2として採用。作者公式配布 / 公式GitHubから入手する。
- 配布時はSoundFontの**原本ライセンス全文**と帰属情報を `public/licenses/` に同梱し、画面の「音源情報」から参照可能にする。
- 作者はソフトウェアへの組み込みを認めているが、含まれる一部サンプルの出自について留保も記載している。公開前に最新の配布条件を再確認する。MML Studio自体のライセンスと音源素材のライセンスは分けて扱う。
- **作者サイトのダウンロードファイルへ直接ホットリンクしない**。配布条件に従い自身のサイトから提供するか、配布元サイトへの案内を行う。
- 実装時に `public/soundfonts/GeneralUser-GS.sf2` へ配置する。**公開するMVPでは標準GM音源を再生可能な状態にすることを必須**とし、音源がない公開ビルドは完成扱いにしない。ソース管理に含めるかはサイズ・ホスティング制限・配布条件を確認して決める。開発用環境で音源が未配置の場合は画面で明示し、手動SF2読み込みでも動作可能にする。
- 他のSoundFontに切り替えられるUIを用意する。ローカル `.sf2` を File API から読み込み、サーバーにアップロードしない。ローカル音源はページ再読み込み後の永続保存を**初期実装ではしない**。

### 5.3 再生手順

1. 「再生」などの**ユーザー操作を契機に** `AudioContext` を生成・resume（自動再生制限対応）。
2. `audioWorklet.addModule()` に `spessasynth_processor.min.js` を渡す。
3. `new WorkletSynthesizer(audioContext)` を生成し、`soundBankManager.addSoundBank(arrayBuffer, 'main')` でSF2を登録する。
4. シンセの ready を待ち、**`new Sequencer(synth, { skipToFirstNoteOn: false })`** を作る。
5. 独自 `writeSmf` の `Uint8Array` 出力から**実データ範囲だけの `ArrayBuffer`**を作り、`sequencer.loadNewSongList([{binary: arrayBuffer, fileName: 'mml-studio.mid'}])` に渡す。
6. MIDIの非同期ロードを `songChange` 等のイベントで確認後 `sequencer.play()` を呼ぶ。
7. 一時停止 `sequencer.pause()`、シーク `sequencer.currentTime = seconds`、停止は `pause()` → `currentTime=0` → `synth.stopAll(true)` を基本とする。ライブラリの実挙動を結合テストで検証し、必要なら順序を調整する。
8. シンセをページから破棄するときは `destroy()` で確実に解放する。

- 音源初期化時に**多重クリックで複数のシンセを作らない**。多重初期化はPromiseを共有する。
- `spessasynth_processor.min.js` を **npmにインストールされた本体と同じバージョン**から `public/` へコピーする自動スクリプトを用意する。古いworkletの混入を防ぐ。
- Vite配信パスには `import.meta.env.BASE_URL` を使用して、`https://<user>.github.io/<repo>/` のサブパスで音源・workletが読めるようにする。
- ファイル読み込み失敗、AudioWorklet非対応、AudioContext再開失敗、音源のGMプリセット不足、CORS/404を識別可能なエラーとして表示する。
- 再生中にMMLを書き換えても**現在再生中の曲は自動変更しない**。「再生」し直した時点で最新ソースを再コンパイルして差し替える。MIDIインポート時の元MIDI再生は元ファイルバイト列をコピーして保持し、MMLの変更に引きずられない。
- 音源切替中は演奏を停止し、音源をロードし直してから再生可能にする。旧リクエストの遅延完了が新しい選択を上書きしないようキャンセル／世代管理する。
- `Sequencer` によるMIDI再生が音源固有のドラムプログラムやGSセットアップを期待どおり解決するか、実際のGMドラム音で確認する。

### 5.4 UIに出す状態

`idle` / `loading-soundfont` / `compiling` / `ready` / `playing` / `paused` / `error` を明示し、不正な状態での操作を防ぐ。標準SoundFontは再生前にダウンロードし、可能なら読み込み進捗を表示。HTTPキャッシュを活用し、再読み込みのたびに必ず再ダウンロードさせない。オフライン完全対応やService WorkerによるキャッシュはMVP対象外。

---

## 6. 画面・ユーザー体験

### 6.1 デスクトップ向け画面

- 上部: アプリ名、MMLファイルを開く、**MIDIファイルを開く**（Phase 4）、`.mml` 保存、`.mid` 書き出し、ヘルプ。
- 中央メイン: CodeMirror エディタ（モノスペース、行番号、MMLハイライト、エラー波線と説明）。
- 右または下ペイン: トラック一覧（MMLから自動検出した番号、チャンネル、GM音色名、必要ならノート数）。トラックの選択は**表示用途**。ソースを勝手に書き換えない。
- 下部プレイヤー: ▶ 再生、⏸ 一時停止、■ 停止、シークバー、現在時刻 / 全体時間。MIDIインポート後は**「元MIDI／MML」切替と「忠実度優先／読みやすさ優先」変換設定**を追加する。
- 設定: 標準SoundFont / ローカルSF2の選択、読込状態、標準GM128音色の表（検索可）、音源ライセンス。
- エラー欄: エラー数、行番号、原因、該当部分クリックでジャンプ。重大なMMLコンパイルエラーがある間は **MMLの新規再生・MMLからのMIDI書き出し**を禁止するが、元MIDIの直接再生は可能なままにする。MIDIインポート診断は別パネルで表示する。
- サンプル: 「ピアノの音階」「ピアノ＋ストリングス」「ドラム入り3トラック」「テンポ変更」を初期搭載。
- 編集内容は `localStorage` に下書き保存（debounce）。ブラウザデータ消去時に消えることを説明。ユーザーのMMLを外部送信しない。
- 画面幅の狭い環境ではパネルを縦に並べる。MVPの重点はデスクトップブラウザ。

### 6.2 操作

- 初回ページ表示では音源を強制再生・強制初期化しない。最初の「再生」でユーザー操作に基づきAudioContextを有効化。
- 初回サンプルはMMLエディタ内に事前入力し、再生ボタンで鳴らせる。
- 空ファイルはコンパイルエラーではなく「演奏する音符がありません」と案内し、再生しない。
- ローカル `.mml` / `.mid` / `.midi` を開く時に、未保存編集内容を上書きすることを確認する。MIDIインポートではドラッグ＆ドロップにも対応する。
- シークは楽曲長内に制限し、ドラッグ中のUI更新で再生位置が跳ねないようにする。
- 必須アクセシビリティ: ボタンに名前を付け、キーボード操作、フォーカス表示、エラーを色だけに頼らない。

---

## 7. ファイル構成（推奨・分割方針は維持）

```text
mml-studio/
├── SPEC.md
├── CLAUDE.md
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── index.html
├── public/
│   ├── soundfonts/
│   │   └── GeneralUser-GS.sf2          # 公式配布から取得 / ライセンス確認
│   ├── licenses/
│   │   └── GeneralUser-GS-LICENSE.txt
│   └── spessasynth_processor.min.js   # 依存バージョンから自動コピー
├── scripts/
│   └── copy-worklet.mjs
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── engine/
│   │   ├── types.ts
│   │   ├── tokenizer.ts
│   │   ├── parser.ts
│   │   ├── compiler.ts
│   │   ├── timing.ts
│   │   ├── smf-writer.ts
│   │   ├── smf-reader.ts            # Phase 4
│   │   ├── midi-normalizer.ts       # Phase 4
│   │   ├── midi-to-mml.ts           # Phase 4
│   │   ├── midi-roundtrip.ts        # Phase 4
│   │   └── index.ts
│   ├── audio/
│   │   ├── SoundFontPlaybackAdapter.ts
│   │   ├── SoundFontLoader.ts
│   │   └── instrument-names.ts
│   ├── ui/
│   │   ├── MmlEditor.tsx
│   │   ├── TransportBar.tsx
│   │   ├── TrackList.tsx
│   │   ├── SoundFontSelector.tsx
│   │   ├── DiagnosticsPanel.tsx
│   │   ├── MidiImportPanel.tsx      # Phase 4
│   │   ├── ImportReport.tsx         # Phase 4
│   │   └── HelpDialog.tsx
│   ├── samples/
│   ├── hooks/
│   ├── utils/
│   └── styles/
├── tests/
│   ├── engine/
│   ├── midi-import/                 # Phase 4 fixture + roundtrip
│   ├── audio/
│   └── e2e/
└── docs/
    ├── MML_REFERENCE.md
    ├── ARCHITECTURE.md
    └── DECISIONS.md
```

- プロジェクト構造と命名は調整可能。ただし **`src/engine` はReact、SpessaSynth、DOMに依存しない**ことを厳守。
- ユニットテストはブラウザやSoundFont無しで実行できること。
- `.gitignore` に生成物、キャッシュ、ローカル音源の取扱方針を記載する。
- リポジトリが巨大化する場合は音源をGit LFS/リリースアセット等へ移すか、配布方式を見直す。GitHub Pagesのクォータ・帯域・ファイルサイズをデプロイ時に検証。

---

## 8. 受け入れテスト（最低限）

以下の例は `PPQ=480`, `q90`, `o4c=60` を前提とする。**音符IRの正確な値をアサート**すること。

| ID | 入力 | 期待結果 |
|---|---|---|
| L01 | `o4 c d e` | pitch 60,62,64、各480tick、start 0/480/960 |
| L02 | `o4 l8 cdef` | 4音、各240tick、合計960tick |
| L03 | `o4 c4.` | 1音、duration720、gate648 |
| L04 | `l8. c r c4` | 最初の音360tick、休符360tick、最後480tick、終端1200tick |
| L05 | `o4 c+ d- f#` | pitch61,61,66 |
| L06 | `o4 >c <c` | pitch72,60 |
| L07 | `v127 q100 c4` | velocity127、gate480 |
| L08 | `q0 c4` | note-on無し、cursor480 |
| L09 | `c4^8` | 1音、duration720 |
| L10 | `c4&c4` | 1音、duration960、gate864 |
| L11 | `c4&d4` | 同音高ではないのでエラー |
| L12 | `t120 c4 t60 c4` | テンポ tick0=120、tick480=60、全体約1.5秒 |
| L13 | `TR(1)c4 TR(2)e8 TR(1)d4` | track1の2音はtick0/480、track2の1音はtick0 |
| L14 | `TR(1)CH(1)@1c4 TR(2)CH(2)@49e4` | プログラム0と48、チャンネル0と1 |
| L15 | `TR(1) CH(10) n36 n38 n42` | 10chのドラムノート36,38,42 |
| L16 | `TR(1)CH(1)c4 TR(2)CH(1)e4` | チャンネル重複エラー |
| L17 | `TR(0)t100 TR(1)c4` | テンポ100、track1が演奏 |
| L18 | `TR(0)c4` | コンダクター内の音符エラー |
| L19 | `TR(1)t120 TR(2)t140` | 同tickテンポ競合エラー |
| L20 | `// test\no4 c4 /*x*/ d4` | コメントを無視して2音 |
| L21 | `TR(1) o4 c4 TR(2) o5 c4 TR(1) d4` | track1のオクターブ4、時間カーソル480を維持 |
| L22 | `@129`, `v128`, `q101`, `o10`, `l3` | 各々明確な範囲エラー |
| L23 | `c4.`, `c4`, `r4` | note-off・end-of-track・休符終端を正しく処理 |
| L24 | `TR(10)c4` | 自動チャンネル11、MIDI側は10（0始まり） |
| L25 | `n60` | pitch60、既定音長480 |
| L26 | `c4&c4&c4` | 1音、duration1440、gate1296 |

追加で以下をテストする。

1. **SMFのラウンドトリップ**: 出力を独立MIDIパーサーで読み、header type1、PPQ480、track数、NoteOn/Off、Program、Tempo、EOTを照合する。
2. **負荷・境界**: 空文字、末尾コメント、壊れたブロックコメント、Unicode、未知文字、音高範囲外、大量音符・長すぎる入力、32トラック超過。
3. **音楽的境界**: 同tickのNoteOff→NoteOn、テンポ変更直後、付点とタイ、`TR`往復時の状態、ドラムのチャンネル番号。
4. **ブラウザ実機**: ピアノ、ストリングス、ドラムが各々聞こえる／一時停止・再開・シーク・停止で発音残りがない／サブパス公開でWorkletとSF2が404にならない。
5. **ユーザー操作**: SF2読み込み失敗後の再試行、ローカルSF2への切替、再生ボタン連打、編集中の再生維持、構文エラー時のエディタジャンプ。

### Phase 4の必須受け入れテスト（L27〜L46）

| ID | 入力・操作 | 期待結果 |
|---|---|---|
| L27 | `o4 'ceg'4 d4` | C4/E4/G4がtick0、D4がtick480。同時和音でcursorは480のみ進む |
| L28 | `o4 'n60 n64 n67'%300` | 3音ともtick0/duration300、cursor300 |
| L29 | `o4 Sub{ c4 e4 } g4` | cがtick0、eがtick480、gがtick0（Sub終了後cursor復帰） |
| L30 | `o4 Time(2:2:36)c%123` | C4の開始tick2436、duration123 |
| L31 | `TR(0)Time(2:1:0)Tempo(90) TR(1)c4` | tick1920に90BPMイベント、tick0にノート |
| L32 | `o4 q%375 c%480` | duration480、gate375。`q90`とは独立 |
| L33 | `CC(64,127) PB(-1024) c4` | tick0にCC64=127とPitchBend=-1024、ノート開始tick0 |
| L34 | `TR(1)CH(1) o4 'c>e<g'4 d4` | chord pitch60,76,67。次のdは62、外側オクターブ不変 |
| L35 | 単純なSMF0（2チャンネル） | 2つのTR/CHへ分割、MML再コンパイル成功 |
| L36 | SMF1（別MTrk・同ch） | 同chイベントを1つのTRへマージ、channel重複エラーなし |
| L37 | PPQ96、tempo変更、Note On/Off | PPQ480に換算、テンポtick換算、開始と終了が一致 |
| L38 | running status、NoteOn velocity0、VLQ>127 | 例外なく正確にデコード・ノート復元 |
| L39 | 同tick・同長・同velocityのC/E/G和音 | MMLに引用符和音を出し、再コンパイルした3音が一致 |
| L40 | 同tick・異長・異velocityの和音 | `Time(...)`/個別note等で正確に表現、音欠けなし |
| L41 | CC64, CC7, PB、GM音色、CH10ドラム | 忠実モードMMLに反映、再生成SMFの対象イベントを照合 |
| L42 | 忠実モードでSMF→MML→SMF | 対応イベントについて音高/ch/velocity/on/offTick/tempo/program/CC/PB一致（PPQ丸めのみ許容） |
| L43 | 読みやすさ優先、1/16でグリッド外ノート | 開始位置と音長を120tickへ量子化、変更差分をレポート |
| L44 | SMF Type2、SMPTE、破損VLQ、過大ファイル | MML化を安全に拒否し、理由を表示。無限ループなし |
| L45 | 元MIDIとMML再生切替、MML編集 | 元MIDIは変化せず、MML側のみ変化。音源は共通 |
| L46 | メタ拍子/歌詞/SysEx/未対応イベントあり | 元MIDIは保持、変換で失う情報を件数付き警告 |

**追加確認**: 同一ch/pitch重複ノート、未終端ノート、ペダルで音が残る場合、テンポ変更と巻戻しTimeの混在、Unicodeコメント、多トラック大量イベント、Web Workerの終了・再試行、デフォルト `q90` が忠実変換を壊さないことを検証する。

### Phase 6aの必須受け入れテスト（L47〜L61）

| ID | 入力 | 期待結果 |
|---|---|---|
| L47 | 見出し行＋演奏行 2 行・パート 3 | 3 トラック、各パートが行順に連結、曲名がコメントに残る |
| L48 | `"O4CDE","O3C2"` を 2 行 | パートごとに O/L/V/Q/@ が行をまたいで継続 |
| L49 | `L8 C..` / `C.` / `C32` | 420 / 360 / 60 tick。`..` は `%420` |
| L50 | `L6 C` / `L12 C` / `L3 C` | 320 / 160 / 640 tick（`%N`） |
| L51 | `{CDE}4` / `{CDEFG}4` | 160×3 / 96×5 tick、合計 480 |
| L52 | `V15` / `V8` / `@V110` / `V8@V100` | velocity 127 / 68 / 110 / 100 |
| L53 | `Q8` / `Q7` / `Q4` を L4 で | gate 480 / 422 / 240 |
| L54 | `O4C` / `O4A` / `>C` / `<C` | 60 / 69 / 72 / 48 |
| L55 | パート 1・2 に同じ `T140`、パート 3 に `T100` | テンポは 140 のみ、警告 1 件 |
| L56 | `@46`, `@13`, パート 4 | `@7`、`@1`、パート 4 は既定 `@81`、元音色名のコメント |
| L57 | `Z0,3`, `S1`, `M255`, `Y1,2`, `MB` | 音は変換され、Z/S/M/Y は件数付き警告、MB は警告なし |
| L58 | `A #`, `< A>`（空白入り）、小文字 | 空白を無視して A#、オクターブ移動が正しい |
| L59 | 見出し行が 2 つ | 曲一覧 2 件、指定した曲だけ変換 |
| L60 | 不正な文字、`GOTO` 行、引用符が閉じていない行 | 行・列付きエラー、変換しない |
| L61 | すべての変換結果 | `compileMml` でエラー無し、変換器の音符列と一致 |

テストデータは自作する。**他者が作成した MML はリポジトリに含めない**（手元での確認にだけ使う）。

---

## 9. 実装フェーズと完了条件

### Phase 0 — 骨格とライブラリ動作検証

- Vite+React+TS+Vitest+Playwrightのセットアップ。
- SpessaSynth 4.4系を導入し、worklet自動コピーを作る。
- 音源を読み込み、**手書きの短いSMFまたは固定MIDIイベント**でピアノを1音鳴らす小さな動作検証。
- GeneralUser GSの入手・配置・ライセンスファイル同梱フローを確立。
- 終了条件: `npm run dev` でブラウザから音が鳴ること、`npm run build` 成功。

### Phase 1 — 独自MMLコア

- 字句解析・構文解析・トラックごとの状態・IR・tempo map・音符/休符/音長/付点/タイ/音色/ドラム。
- 上記L01〜L26の単体テストを追加。
- 独立したSMF Type1 writerの実装。
- 終了条件: 全コアテスト成功、SMF検証成功。`src/engine` がDOM・音源非依存。

### Phase 2 — エディタと再生

- CodeMirror、MMLサンプル、エラー表示、トラック一覧、音色表示。
- MML → SMF → Sequencer → SF2 → 音声再生の一連を接続。
- 再生、停止、一時停止、シーク、曲長・時刻表示。AudioContextの初回ユーザー操作制約に対応。
- 終了条件: 3トラックのピアノ・ストリングス・ドラムサンプルが同時に鳴り、停止時に鳴りっぱなしがない。

### Phase 3 — MVP完成

- `.mml` ファイルの読み込み・書き出し、`.mid` 書き出し。
- ローカル `.sf2` の読み込みと標準音源への切替。
- GM音色一覧、エラー案内、基本ヘルプ、localStorage下書き、アクセシビリティ。
- GitHub Pages想定のbase path対応。自動テスト・手動実機確認・README整備。
- 終了条件: 初回訪問者がサンプルを再生し、自作MMLを入力→演奏→保存できる。`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` が成功。

### Phase 4 — MIDIインポート・MML化（本依頼で追加した必須機能）

- Phase 4言語拡張（和音 `'ceg'4`、`Sub{}`、`Time(M:B:S)`、`%N`音長、`q%N`、`CC`、`PB`、`TempoUS`）のパーサー/IR/SMF writer実装とテスト。
- 独自SMF Reader（Type 0/1・PPQ・running status等）、ノート/テンポ/音色/コントローラ正規化、SMF→MMLシリアライザー。
- **忠実度優先**と**読みやすさ優先**、グリッド選択、欠落・丸め・量子化差分のレポート。
- 元MIDI直接再生、変換MML編集・再生・保存、原MIDI/MMLの聴き比べ、File API/ドラッグ＆ドロップ。
- 終了条件: L27〜L46すべて成功、RoundTrip検証成功、一般的なGM曲を読み込んで演奏・MML編集・MML保存できる。未対応コントローラ等はユーザーへ明示。

### Phase 5 — 安定化（MIDIインポート完成後に実施）

- 複雑なMMLでの速度改善、SF2ロード失敗時の回復、Safari/Firefoxなどの互換性。
- 楽曲編集・音源切替・シーク連打などの競合状態を重点的に改善。
- 公式配布音源の著作権帰属・ライセンス表記とデプロイ手順を最終検証。
- `docs/MML_REFERENCE.md` を実装済みの構文だけで記述し、サンプルと同期。

### Phase 6a — PC-9801 `PLAY`（行番号形式）の変換

- 4.5.1〜4.5.6 の実装、L47〜L61 のテスト、変換ダイアログの E2E、実ブラウザでの再生確認。
- 未確認の項目（`O4C` の基準、`N` の番号、`^`、`Z` の 2 引数形、連符の既定長、音色番号表）を `docs/DECISIONS.md` に仮定として記録し、ヘルプにも「推定で変換している項目」として載せる。
- 終了条件: L47〜L61 成功、実際の PC-9801 `PLAY` データを手元で変換して再生でき、警告の内容が妥当であること。

### Phase 6b — picosakura（別途追記）

- 対象構文（`TR 1`、和音内の `o`、音長の `+` など）と変換表は別途追記する。

**MVP（Phase 0〜3）とMIDIインポート拡張（Phase 4）のそれぞれで必須の全項目が実ブラウザで動くまでは、該当段階を「完成」と判定しない。**

---

## 10. README と作業報告の要件

READMEには以下を含める。

1. プロジェクト概要・スクリーンショット（実装後）・ブラウザ対応範囲。
2. 開発環境、初回セットアップ、音源入手・配置、`npm run dev`/`build`/`test`。
3. MML Studio とサクラMMLの違い（特に小文字` t `・`o4c`・`v`・`q`）。
4. `TR/CH` の使い方、ドラムの `n36` 等、GM音色番号（UI=1..128、MIDI=0..127）。
5. `.mml` / `.mid` の入出力、**MIDIインポート→和音/`Sub`/`Time`を含むMML変換の手順、忠実度/読みやすさモードの差、非対応イベントと丸め誤差**、SF2ローカル読込、音源権利・ライセンス。
6. GitHub Pagesのビルド・公開手順とVite base pathの設定方法。
7. 未実装構文と既知の制限を正直に記載。

各 Phase の作業報告には「追加・変更したファイル」「実行した検証コマンドと結果」「手動確認結果」「未解決事項」「次の作業」を含める。コードを省略して仕様だけ更新することを完了としない。

---

## 11. 初期サンプルMML（実装・テストに使用）

### 11.1 単純な音階

```mml
// Acoustic Grand Piano
TR(1) CH(1) @1
Tempo(120) o4 l8 v100 q90
cdef gab>c
```

### 11.2 3トラックとドラム（4/4、各トラック4拍）

```mml
// 全体のテンポ
TR(0) Tempo(120)

// Piano
TR(1) CH(1) @1
 o4 l4 v105 q90
 c e g >c

// Strings
TR(2) CH(2) @49
 o3 l2 v80 q100
 c g

// Drums (GM channel 10)
TR(3) CH(10)
 l8 v110 q90
 n36 n42 n38 n42 n36 n42 n38 n42
```

### 11.3 テンポ変更とトラック時刻の独立

```mml
TR(0) Tempo(120)
TR(1) CH(1) @1
 o4 l4 c e g c
TR(2) CH(2) @49
 o3 l2 c g
TR(0) // TR(0) はテンポ専用。時間カーソルが動かないので
       // この行に Tempo(90) を書くと tick0 で競合する。
```

**注意**: 楽曲中盤のテンポ変更は、`TR(1)` など既に時刻が進んでいる演奏トラック上で `t90` と記述する。コンダクタートラックで任意tickに移動する構文はMVPには無い。

### 11.4 中盤でのテンポ変更（正しい例）

```mml
TR(1) CH(1) @1
 t120 o4 l4
 c d e f
 t90
 g a b >c

TR(2) CH(2) @49
 o3 l1
 c g
```

---

### 11.5 和音・声部重ね（Phase 4）

```mml
TR(0) Time(1:1:0) Tempo(120)
TR(1) CH(1) @1 o4 l4 v100 q100
'ceg'4 'dfa'4
// 同じチャンネルの別声部を重ねる（Sub終了時に演奏位置だけ復帰）
Time(2:1:0) Sub{ v70 c4 e4 g4 } v100 g4
```

### 11.6 MIDIから生成するMMLの例（忠実度優先）

```mml
// SMF0 import / PPQ480 / pitch, velocity, note-offの一致を優先
TR(0) Time(1:1:0) TempoUS(500000)
TR(1) CH(1) @1
Time(1:1:0) v92 q%360 'n60 n64 n67'%480
Time(1:2:0) CC(64,127)
Time(1:2:0) v85 q%216 n69%240
Time(1:3:0) CC(64,0)
```

---

## 12. 既知の設計判断と注意事項

- MMLには統一標準がないため、互換性の優先順位は **基本MML共通構文 ＞ 使いやすいMIDI表現 ＞ サクラ拡張の一部** とする。
- ドラムのGMチャンネル10はMIDI実装上のch9（0始まり）。誤ってch10に送らない。
- GeneralUser GSのドラムキットはSoundFontのプリセット構成に依存する。SF2読み込みだけで「完全なGM互換」を宣言せず、実機・ブラウザで音色確認を行う。
- SoundFontのボリュームやリバーブの聴感は音源とブラウザに左右される。MVPで他のソフトと完全に同じ音を保証しない。
- `.mid` 書き出しに元の`.mml`ソースを埋め込む必要はない。**元MIDIのバイト列をMMLテキストとは別管理**し、変換できないイベントがあっても元MIDIの再生を保持する。
- 音色選択UIがMML内の`@N`を編集する場合には、現在トラック内の既存@コマンドとの関係を決める追加設計が必要。**MVPでは音色一覧は参照・コピー用途とし、エディタソースを自動変更しない**。
- Phase 4で `TR(0) Time(...) Tempo(...)` をサポートする。`Time` の小節・拍は常に4/4基準で、入力MIDIの拍子メタイベントとは区別する。
- 仕様と実装が相違する場合、互換性の曖昧さを理由に黙って変更せず、テストを伴う明示的な仕様変更を行う。

---

## 13. 参考文献（仕様を自動継承するものではない）

- サクラMML（既存の構文の参照用・コードの取り込み禁止）: https://github.com/kujirahand/sakuramml-rust
- サクラ コマンド一覧（TR/CH等の表記確認用）: https://github.com/kujirahand/sakuramml-rust/blob/main/command.md
- サクラ MML 入門: https://sakuramml.com/doc/kouza/mml1.htm
- SpessaSynth 公式ドキュメント: https://spessasus.github.io/spessasynth_lib/
- SpessaSynth Sequencer: https://spessasus.github.io/spessasynth_lib/classes/Sequencer/
- SpessaSynth WorkletSynthesizer: https://spessasus.github.io/spessasynth_lib/classes/WorkletSynthesizer/
- SpessaSynth Workletの配置: https://spessasus.github.io/spessasynth_lib/synthesizer/importing-the-worklet/
- GeneralUser GS 公式: https://www.schristiancollins.com/generaluser
- GeneralUser GS 公式GitHub: https://github.com/mrbumpy409/GeneralUser-GS

**最終実装指示**: Phase 0〜3でMMLプレイヤーを完成させ、Phase 4でMIDIインポート→MML変換（和音・複雑な重なり・2モード）を実装する。各段階で単体テスト・実ブラウザ確認まで完了してから結果を報告すること。曖昧な方言差を未確認のまま「標準MML完全互換」と称してはいけない。

---

## 付録 A: FM 音色（0〜81）→ GM 音色（MML Studio の `@1`〜`@128`）

名前からの推定。聴感の一致は保証しない。効果音系は近い GM 効果音に置き換える。

| FM | 名前 | GM | | FM | 名前 | GM |
|---|---|---|---|---|---|---|
| 0 | Default VOICE | @1 Acoustic Grand Piano | | 41 | VIBRPHN | @12 Vibraphone |
| 1 | BRASS 2 | @63 Synth Brass 1 | | 42 | XYLOPHN | @14 Xylophone |
| 2 | STRING 2 | @50 String Ensemble 2 | | 43 | KOTO | @108 Koto |
| 3 | EPIANO 3 | @5 Electric Piano 1 | | 44 | ZITAR | @105 Sitar |
| 4 | EBASS 1 | @34 Electric Bass (finger) | | 45 | CLAV | @8 Clavi |
| 5 | EORGAN 1 | @17 Drawbar Organ | | 46 | HARPSIC | @7 Harpsichord |
| 6 | PORGAN 1 | @20 Church Organ | | 47 | BELL | @15 Tubular Bells |
| 7 | FLUTE | @74 Flute | | 48 | HARP | @47 Orchestral Harp |
| 8 | OBOE | @69 Oboe | | 49 | BELL/BRASS | @62 Brass Section |
| 9 | CLARINET | @72 Clarinet | | 50 | HARMONICA | @23 Harmonica |
| 10 | VIBRPHN | @12 Vibraphone | | 51 | STEEL DRUM | @115 Steel Drums |
| 11 | HARPSIC | @7 Harpsichord | | 52 | TIMPANI | @48 Timpani |
| 12 | BELL | @15 Tubular Bells | | 53 | TRAIN | @126 Helicopter |
| 13 | PIANO | @1 Acoustic Grand Piano | | 54 | AMBULAN | @126 Helicopter |
| 14 | MUSHI | @124 Bird Tweet | | 55 | TWEET | @124 Bird Tweet |
| 15 | DESCENT | @104 FX 8 (sci-fi) | | 56 | RAIN DROP | @97 FX 1 (rain) |
| 16 | UFO | @104 FX 8 (sci-fi) | | 57 | HORN | @61 French Horn |
| 17 | GRANPRI | @126 Helicopter | | 58 | SNARE DRUM | @119 Synth Drum |
| 18 | LASER 1 | @104 FX 8 (sci-fi) | | 59 | COW BELL | @114 Agogo |
| 19 | LASER 2 | @104 FX 8 (sci-fi) | | 60 | PERC 1 | @118 Melodic Tom |
| 20 | SIN WAVE | @80 Ocarina | | 61 | PERC 2 | @118 Melodic Tom |
| 21 | BRASS 1 | @62 Brass Section | | 62 | PERC 3 | @116 Woodblock |
| 22 | BRASS 2 | @63 Synth Brass 1 | | 63 | MUSIC BOX | @11 Music Box |
| 23 | TRUMPET | @57 Trumpet | | 64 | CELLO | @43 Cello |
| 24 | STRING 1 | @49 String Ensemble 1 | | 65 | LOW BRASS | @58 Trombone |
| 25 | STRING 2 | @50 String Ensemble 2 | | 66 | WW ENSMBL | @69 Oboe |
| 26 | EPIANO 1 | @5 Electric Piano 1 | | 67 | AC GUITAR | @25 Acoustic Guitar (nylon) |
| 27 | EPIANO 2 | @6 Electric Piano 2 | | 68 | FLUTE/HARP | @74 Flute |
| 28 | EPIANO 3 | @5 Electric Piano 1 | | 69 | FUNK PLUC | @28 Electric Guitar (clean) |
| 29 | GUITAR | @26 Acoustic Guitar (steel) | | 70 | FUNK BASS | @37 Slap Bass 1 |
| 30 | EBASS 1 | @34 Electric Bass (finger) | | 71 | SYN LEAD | @82 Lead 2 (sawtooth) |
| 31 | EBASS 2 | @35 Electric Bass (pick) | | 72 | METAL CLES | @99 FX 3 (crystal) |
| 32 | EORGAN 1 | @17 Drawbar Organ | | 73 | STAIN | @89 Pad 1 (new age)（名前の意味不明・推定） |
| 33 | EORGAN 2 | @18 Percussive Organ | | 74 | CUBIN GLASS | @99 FX 3 (crystal) |
| 34 | PORGAN 1 | @20 Church Organ | | 75 | HUMAN | @53 Choir Aahs |
| 35 | PORGAN 2 | @20 Church Organ | | 76 | WOOD BASS | @33 Acoustic Bass |
| 36 | FLUTE | @74 Flute | | 77 | CHIMES | @15 Tubular Bells |
| 37 | PICCOLO | @73 Piccolo | | 78 | SPACY | @92 Pad 4 (choir) |
| 38 | OBOE | @69 Oboe | | 79 | OBOE/BCLAR | @69 Oboe |
| 39 | CLARINET | @72 Clarinet | | 80 | OLD STRING | @49 String Ensemble 1 |
| 40 | GROCKEN | @10 Glockenspiel | | 81 | STEEL'S CRY | @31 Distortion Guitar（推定） |

注意: この番号と音色名の対応が PC-9801 の N88-BASIC(86) と同じかは**未確認**。違いが分かれば表だけを差し替える（変換器はこの表をデータとして持つ）。
