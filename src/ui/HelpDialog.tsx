import { Modal } from './Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

const COMMANDS: Array<[string, string, string]> = [
  ['c d e f g a b', 'ドレミファソラシ', 'cdefgab'],
  ['+ # -', '直前の音名を半音上げ／下げ（1個まで）', 'c+ f# b-'],
  ['r', '休符', 'r4 r8.'],
  ['oN', 'オクターブ（0〜9、初期値4）。o4c = MIDI 60（中央のC）', 'o5'],
  ['> <', 'オクターブを +1 / −1（> が高い）', '>c <g'],
  ['lN / lN.', '省略時の音長（1,2,4,8,16,32,64、付点1個まで）', 'l8 l8.'],
  ['cN / cN.', '個別の音長と付点', 'c4 d8.'],
  ['^N', '直前の音符に音長を加算', 'c4^8'],
  ['&', '同じ音高の音符をつないで1音にする', 'c4&c4'],
  ['nN', 'MIDI ノート番号で直接指定（音長は l に従う）', 'n60 n36'],
  ['tN / Tempo(N)', 'テンポ（四分音符/分、20〜300、初期値120）。楽曲全体で共通', 't140'],
  ['vN', 'ベロシティ（0〜127、初期値100）。v0 は無音', 'v96'],
  ['qN', 'ゲート率 %（0〜100、初期値90）。q0 は無音', 'q85'],
  ['@N', 'GM 音色（1〜128、初期値1）', '@49'],
  ['TR(N) / Track(N) / TR=N', 'トラック切替（0〜32）。TR(0) はテンポ専用', 'TR(2)'],
  ['CH(N) / Channel(N) / CH=N', 'MIDI チャンネル（1〜16、10 は GM ドラム）', 'CH(10)'],
  ['\'ceg\'4', '和音（同時に発音、全音で音長・v・q を共有）。< > は和音の中だけ有効', "'ceg'4 'n60 n64'8"],
  ['Sub{ … }', '中を演奏したあと演奏位置だけ元に戻す（o/l/v/q/@ の変更は残る）。入れ子8階層まで', 'Sub{ c4 e4 } g2'],
  ['Time(M:B:S)', '演奏位置を絶対指定（4/4 固定座標: 小節・拍は1始まり、S は 0〜479 tick）', 'Time(2:1:0)'],
  ['c%N / r%N / n60%N / l%N', '音長を tick（PPQ 480）で指定', 'c%372 n36%120'],
  ['q%N', '発音長を tick で指定（記譜長を超えてもよい）。qN と切り替わる', 'q%359'],
  ['CC(C,V)', 'コントロールチェンジ（0〜127）。時間は進まない', 'CC(64,127)'],
  ['PB(N)', 'ピッチベンド（-8192〜8191、中央0）。時間は進まない', 'PB(-1024)'],
  ['TempoUS(N)', 'テンポを μs/4分音符で厳密指定（1〜16777215）', 'TempoUS(500000)'],
  ['// …  /* … */', 'コメント', '// メモ'],
];

const DRUMS: Array<[number, string]> = [
  [35, 'Acoustic Bass Drum'], [36, 'Bass Drum 1'], [37, 'Side Stick'], [38, 'Acoustic Snare'], [39, 'Hand Clap'],
  [40, 'Electric Snare'], [41, 'Low Floor Tom'], [42, 'Closed Hi-Hat'], [43, 'High Floor Tom'], [44, 'Pedal Hi-Hat'],
  [45, 'Low Tom'], [46, 'Open Hi-Hat'], [47, 'Low-Mid Tom'], [48, 'Hi-Mid Tom'], [49, 'Crash Cymbal 1'],
  [50, 'High Tom'], [51, 'Ride Cymbal 1'], [52, 'Chinese Cymbal'], [53, 'Ride Bell'], [54, 'Tambourine'],
  [55, 'Splash Cymbal'], [56, 'Cowbell'], [57, 'Crash Cymbal 2'], [59, 'Ride Cymbal 2'],
];

export function HelpDialog({ open, onClose }: Props) {
  return (
    <Modal open={open} title="ヘルプ — MML Studio 方言" onClose={onClose} wide>
      <p>
        MML には統一された公式規格がないため、MML Studio は独自に定義した方言を使います。
        <strong>サクラ MML と完全互換ではありません。</strong>
      </p>

      <h3>コマンド</h3>
      <table className="track-table help-table">
        <thead>
          <tr>
            <th scope="col">記述</th>
            <th scope="col">意味</th>
            <th scope="col">例</th>
          </tr>
        </thead>
        <tbody>
          {COMMANDS.map(([cmd, desc, ex]) => (
            <tr key={cmd}>
              <td>
                <code>{cmd}</code>
              </td>
              <td>{desc}</td>
              <td>
                <code>{ex}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        音長・付点・臨時記号・数値はコマンドに空白を入れずに続けて書きます（<code>c4</code> は可、<code>c 4</code> はエラー）。英字コマンドは大文字・小文字を区別しません。
      </p>

      <h3>サクラ MML との主な違い</h3>
      <ul>
        <li>
          小文字 <code>t</code> は<strong>テンポ</strong>です（サクラでは発音タイミング調整）。
        </li>
        <li>
          <code>o4c</code> は MIDI ノート 60（中央の C）です。
        </li>
        <li>
          <code>v</code> は MIDI ベロシティ 0〜127、<code>q</code> は音長に対する発音長の割合（%）です。
        </li>
        <li>
          <code>[ ]</code> ループ、<code>{'{ }'}</code> 連符、マクロ、変数、ストトン、日本語構文は未対応です（エラーになります）。
        </li>
        <li>
          <code>&amp;</code> は同じ音高のタイのみ。異なる音高のスラーは未対応です。
        </li>
      </ul>

      <h3>トラックとチャンネル</h3>
      <ul>
        <li>トラックはそれぞれ独立した時間軸で、どれも tick 0 から始まります。トラックを切り替えて戻ると、オクターブ・音長などの状態も復元されます。</li>
        <li>
          初期チャンネル: TR(1〜9) → CH 1〜9、TR(10〜15) → CH 11〜16。TR(16〜32) は最初の演奏前に <code>CH(N)</code> が必要です。
        </li>
        <li>異なるトラックで同じチャンネルは使えません。CH は最初の音符・音色指定より前にだけ設定できます。</li>
        <li>
          テンポは楽曲全体で共通です。同じ時刻に異なるテンポを指定するとエラーになります。曲の途中で変える場合は、時刻が進んだ演奏トラック上で <code>t90</code> などと書きます。
        </li>
      </ul>

      <h3>ドラム（CH(10)）</h3>
      <p>
        ドラムは <code>n36</code> のようにノート番号で書くのがおすすめです。<code>o4c</code> は「ド」ではなくノート 60 の打楽器（Hi Bongo）になります。
      </p>
      <ul className="drum-list">
        {DRUMS.map(([n, name]) => (
          <li key={n}>
            <code>n{n}</code> {name}
          </li>
        ))}
      </ul>

      <h3>演奏表示（ピアノロール・チャンネル）</h3>
      <ul>
        <li>エディタの下に、演奏中の音を表示します（「▾」で開閉、上の境界をドラッグで高さを変更）。「ピアノロール」と「チャンネル」をタブで切り替えます。</li>
        <li>チャンネル表示は、トラックごとに音色・音量（Vol）・エクスプレッション（Exp）・パン・ピッチベンド・レベルと、鳴っている鍵盤を表示します。</li>
        <li>凡例のトラック名をクリックすると、そのトラックの表示を切り替えます（Shift＋クリックでそのトラックだけ表示）。音には影響しません。</li>
        <li>音符をクリックすると MML の該当箇所を選択します。空いた所のクリックでその位置へ移動（再生中・一時停止中）します。</li>
        <li>Ctrl（Mac は ⌘）＋ホイール、または ＋ / − で時間方向の拡大縮小。停止中はホイールや左右キーで見る位置を動かせます。</li>
        <li>元 MIDI を再生しているときは、元 MIDI の音符を表示します。</li>
      </ul>

      <h3>ファイルとデータ</h3>
      <ul>
        <li>MML と MIDI の処理はすべてブラウザ内で行い、外部へ送信しません。</li>
        <li>
          「ファイル」メニューの「MIDIを開く」（またはドラッグ＆ドロップ）で SMF Format 0/1 を MML に変換します。<strong>忠実度優先</strong>は音高・tick・ベロシティ・Note Off・テンポ・音色・CC・PB を保ち、
          再コンパイルして元の MIDI と一致することを確認します。<strong>読みやすさ優先</strong>は 1/8・1/16・1/32 に量子化し、元との差を表示します。
          拍子・歌詞・SysEx・アフタータッチなど MML にできないイベントは件数付きで表示し、元 MIDI の直接再生では保持されます。
        </li>
        <li>
          「変換」メニューの「他の MML から変換」で、PC-9801 の PLAY 文（<code>01 "…","…"</code> の形式）、MSX-BASIC・PC-8801 N88-BASIC の音楽プログラム（<code>PLAY</code> /{' '}
          <code>CMD PLAY</code>）、picosakura（サクラ MML・日本語 MML）を MML Studio の MML に変換できます。
          変換できない命令や推定で変換した命令は行・列付きで表示します。「変換できない命令はスキップする（近似変換）」をオンにすると、変換できない部分を飛ばして変換できます。
        </li>
        <li>MIDI チャンネルごとに TR(番号=チャンネル) にまとめ、CH を明示します。Time の小節・拍は常に 4/4 の座標で、元の拍子とは一致しないことがあります。</li>
        <li>編集内容はこのブラウザの localStorage に自動で下書き保存されます。ブラウザのデータを消去すると消えるので、大事な MML は「ファイル」メニューの「MML保存」でファイルに保存してください。</li>
        <li>ローカルの SF2 音源はページを再読み込みすると標準音源に戻ります。</li>
        <li>上限: MML 2 MiB、音符 100,000、演奏トラック 32、曲長 2,000,000 tick（PPQ 480）。</li>
      </ul>
    </Modal>
  );
}
