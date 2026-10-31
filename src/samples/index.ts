// Built-in samples (SPEC 6.1 / 11).
export interface Sample {
  id: string;
  title: string;
  source: string;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: 'scale',
    title: 'ピアノの音階',
    source: `// Acoustic Grand Piano
TR(1) CH(1) @1
Tempo(120) o4 l8 v100 q90
cdef gab>c
`,
  },
  {
    id: 'piano-strings',
    title: 'ピアノ＋ストリングス',
    source: `TR(0) Tempo(100)

// Piano
TR(1) CH(1) @1
 o4 l8 v100 q90
 c e g >c< g e c4
 d f a >d< a f d4

// Strings
TR(2) CH(2) @49
 o3 l1 v75 q100
 c
 d
`,
  },
  {
    id: 'three-tracks',
    title: 'ドラム入り3トラック',
    source: `// 全体のテンポ
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
`,
  },
  {
    id: 'tempo-change',
    title: 'テンポ変更',
    source: `// 楽曲途中のテンポ変更: 時刻が進んだ演奏トラック上で t を書くか、
// TR(0) Time(2:1:0) Tempo(90) のようにコンダクタートラックで位置を指定する
TR(1) CH(1) @1
 t120 o4 l4
 c d e f
 t90
 g a b >c

TR(2) CH(2) @49
 o3 l1
 c g
`,
  },
  {
    id: 'chords',
    title: '和音・声部・ペダル',
    source: `// 和音 '...'、Sub{} による声部の重ね、Time() による位置指定、CC(64) のペダル
TR(0) Time(1:1:0) Tempo(96)
TR(0) Time(3:1:0) Tempo(84)   // 3小節目からテンポを落とす

TR(1) CH(1) @1 o4 l4 v96 q100
CC(64,127) 'ceg'2 'c>e<a'2 CC(64,0)
CC(64,127) 'dfa'2 '<b>dg'2 CC(64,0)
// 同じチャンネルの別声部を重ねる（Sub 終了時に演奏位置だけ戻る）
Time(3:1:0) Sub{ v70 q90 c8 e8 g8 >c8< g8 e8 c4 } v100 '<cg'1

TR(2) CH(2) @33 o2 l2 v100 q90
c a f g
Time(3:1:0) c1
`,
  },
];

export const DEFAULT_SAMPLE = SAMPLES[2];
