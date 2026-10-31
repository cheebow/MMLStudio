import { useEffect, useMemo, useRef, useState } from 'react';
import { GM_INSTRUMENTS } from '../engine';
import { isBlackKey, levelAt, notesAt, valueAt, type RollData } from './roll-data';
import { cssVar, laneColor, prefersDark } from './viz-colors';

interface Props {
  data: RollData | null;
  /** playback position in seconds */
  time: number;
  /** lanes switched off in the legend (shown dimmed) */
  hidden: ReadonlySet<number>;
}

const HEAD_H = 18;
const ROW_H = 22;
const COL = { label: 44, voice: 150, meter: 44, level: 64 };

/** white-key index of a MIDI pitch (C-1 = 0) and the number of white keys in 0..127 */
const WHITE_BEFORE = (() => {
  const a: number[] = [];
  let w = 0;
  for (let p = 0; p < 128; p++) {
    a.push(w);
    if (!isBlackKey(p)) w++;
  }
  return a;
})();
const WHITE_COUNT = 75;

/**
 * Channel monitor (SPEC 6.3): one row per track / channel with the voice, volume, expression,
 * pan, pitch bend, a level meter and a full-range keyboard that lights the sounding keys.
 */
export function ChannelMonitor({ data, time, hidden }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const rows = data?.tracks.length ?? 0;
  /** sounding keys per track, for tests and assistive tech (`TR1:60,64;TR2:48`) */
  const active = useMemo(() => {
    if (!data) return '';
    const now = notesAt(data, time);
    return data.tracks
      .map((tr, lane) => {
        const p = [...new Set(now.filter((n) => n.lane === lane).map((n) => n.pitch))].sort((a, b) => a - b);
        return p.length ? `${tr.label}:${p.join(',')}` : '';
      })
      .filter(Boolean)
      .join(';');
  }, [data, time]);
  const height = HEAD_H + Math.max(1, rows) * ROW_H;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = prefersDark();
    const bg = cssVar('--editor-bg', dark ? '#14171c' : '#ffffff');
    const text = cssVar('--text', dark ? '#e6e8ec' : '#1d2330');
    const muted = cssVar('--muted', '#667085');
    const border = cssVar('--border', '#d6dae1');
    const track = dark ? '#262b33' : '#eceef2';
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);

    const voiceW = width < 640 ? 96 : COL.voice;
    const x0 = COL.label;
    const xVoice = x0;
    const xVol = xVoice + voiceW + 6;
    const xExp = xVol + COL.meter + 6;
    const xPan = xExp + COL.meter + 6;
    const xPb = xPan + COL.meter + 6;
    const xLevel = xPb + COL.meter + 6;
    const xKeys = xLevel + COL.level + 8;
    const keysW = Math.max(60, width - xKeys - 4);
    const wk = keysW / WHITE_COUNT;

    // header
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = muted;
    const head = (label: string, x: number) => g.fillText(label, x, HEAD_H / 2);
    head('トラック', 2);
    head('音色', xVoice);
    head('Vol', xVol);
    head('Exp', xExp);
    head('Pan', xPan);
    head('PB', xPb);
    head('Level', xLevel);
    for (let oct = 0; oct <= 9; oct++) {
      const x = xKeys + WHITE_BEFORE[oct * 12 + 12] * wk;
      if (x < xKeys + keysW - 10) g.fillText(`C${oct}`, x + 1, HEAD_H / 2);
    }
    g.fillStyle = border;
    g.fillRect(0, HEAD_H - 0.5, width, 0.5);

    if (!data || rows === 0) {
      g.fillStyle = muted;
      g.font = '12px system-ui, sans-serif';
      g.fillText('演奏する音符がありません', 8, HEAD_H + ROW_H / 2);
      return;
    }

    const sounding = notesAt(data, time);
    data.tracks.forEach((tr, lane) => {
      const y = HEAD_H + lane * ROW_H;
      const color = laneColor(lane, tr.drum, dark);
      const off = hidden.has(lane);
      g.globalAlpha = off ? 0.35 : 1;
      if (lane % 2 === 1) {
        g.fillStyle = dark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)';
        g.fillRect(0, y, width, ROW_H);
      }
      const mid = y + ROW_H / 2;
      // label
      g.fillStyle = color;
      g.fillRect(2, y + 5, 4, ROW_H - 10);
      g.fillStyle = text;
      g.font = '11px system-ui, sans-serif';
      g.fillText(tr.label, 9, mid);
      // voice
      const program = valueAt(tr.program, time, 0);
      const name = tr.drum ? `ドラム（CH${tr.channel + 1}）` : `${program + 1} ${GM_INSTRUMENTS[program] ?? ''}`;
      g.save();
      g.beginPath();
      g.rect(xVoice, y, voiceW, ROW_H);
      g.clip();
      g.fillStyle = text;
      g.fillText(name, xVoice, mid);
      g.restore();
      // volume / expression bars
      const bar = (x: number, v: number) => {
        g.fillStyle = track;
        g.fillRect(x, mid - 4, COL.meter, 8);
        g.fillStyle = color;
        g.fillRect(x, mid - 4, (COL.meter * v) / 127, 8);
      };
      bar(xVol, valueAt(tr.volume, time, 100));
      bar(xExp, valueAt(tr.expression, time, 127));
      // pan / pitch bend: centre line + marker
      const centre = (x: number, ratio: number) => {
        g.fillStyle = track;
        g.fillRect(x, mid - 1, COL.meter, 2);
        g.fillStyle = muted;
        g.fillRect(x + COL.meter / 2 - 0.5, mid - 5, 1, 10);
        g.fillStyle = color;
        g.fillRect(x + ratio * (COL.meter - 4), mid - 5, 4, 10);
      };
      centre(xPan, valueAt(tr.pan, time, 64) / 127);
      centre(xPb, (valueAt(tr.bend, time, 0) + 8192) / 16383);
      // level meter
      const level = levelAt(data, lane, time);
      g.fillStyle = track;
      g.fillRect(xLevel, mid - 4, COL.level, 8);
      g.fillStyle = color;
      g.fillRect(xLevel, mid - 4, COL.level * level, 8);
      // keyboard
      const lit = new Set<number>();
      for (const n of sounding) if (n.lane === lane) lit.add(n.pitch);
      const ky = y + 3;
      const kh = ROW_H - 6;
      g.fillStyle = dark ? '#5a616d' : '#b8bec8';
      g.fillRect(xKeys, ky, keysW, kh);
      for (let p = 0; p < 128; p++) {
        if (isBlackKey(p)) continue;
        g.fillStyle = lit.has(p) ? color : dark ? '#d9dde3' : '#ffffff';
        g.fillRect(xKeys + WHITE_BEFORE[p] * wk + 0.5, ky, Math.max(1, wk - 1), kh);
      }
      for (let p = 0; p < 128; p++) {
        if (!isBlackKey(p)) continue;
        g.fillStyle = lit.has(p) ? color : dark ? '#1f232a' : '#2f343c';
        g.fillRect(xKeys + WHITE_BEFORE[p] * wk - wk * 0.3, ky, wk * 0.6, kh * 0.6);
      }
      g.globalAlpha = 1;
    });
  }, [data, time, hidden, width, height, rows]);

  return (
    <div className="monitor-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="monitor-canvas"
        style={{ height }}
        role="img"
        aria-label={`チャンネル表示（${rows} トラック）。音色・音量・エクスプレッション・パン・ピッチベンド・レベル・鳴っている鍵盤を表示します。`}
        data-testid="channel-monitor"
        data-active={active}
      />
    </div>
  );
}
