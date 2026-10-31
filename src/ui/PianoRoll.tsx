import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import type { SourceSpan } from '../engine';
import { isBlackKey, notesAt, notesBetween, pitchName, pitchWindow, type RollData, type RollNote } from './roll-data';
import { cssVar as css, laneColor, prefersDark } from './viz-colors';

interface Props {
  data: RollData | null;
  /** playback position in seconds */
  time: number;
  playing: boolean;
  /** true when the player can seek (playing / paused) */
  canSeek: boolean;
  onSeek(seconds: number): void;
  onJump(span: SourceSpan): void;
  /** lanes switched off in the legend (not drawn) */
  hidden: ReadonlySet<number>;
  /** pixels per second (zoom) */
  pps: number;
  onZoom(factor: number): void;
}

const KEY_W = 46;
const RULER_H = 16;
const DRUM_H = 18;
export const MIN_PPS = 10;
export const MAX_PPS = 800;

/** Piano roll + keyboard (SPEC 6.3). Drawing only; it never changes the MML or the playback. */
export function PianoRoll({ data, time, playing, canSeek, onSeek, onJump, hidden, pps, onZoom }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 160 });
  /** position shown while stopped (scrolling with the wheel) */
  const [viewTime, setViewTime] = useState(0);
  const [active, setActive] = useState<string>('');
  const hitRef = useRef<Array<{ x: number; y: number; w: number; h: number; note: RollNote }>>([]);

  const shownTime = playing || canSeek ? time : viewTime;
  const window_ = useMemo(() => (data ? pitchWindow(data) : { low: 48, high: 84 }), [data]);
  const hasDrums = useMemo(() => !!data?.notes.some((n) => n.drum), [data]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, el.clientWidth), h: Math.max(60, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl / ⌘ + wheel zooms the roll, not the page (React wheel handlers are passive)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const stop = (e: globalThis.WheelEvent) => {
      if (e.ctrlKey || e.metaKey || !playing) e.preventDefault();
    };
    c.addEventListener('wheel', stop, { passive: false });
    return () => c.removeEventListener('wheel', stop);
  }, [playing]);

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = prefersDark();
    const bg = css('--editor-bg', dark ? '#14171c' : '#ffffff');
    const text = css('--text', dark ? '#e6e8ec' : '#1d2330');
    const muted = css('--muted', '#667085');
    const border = css('--border', '#d6dae1');
    const accent = css('--accent', '#2f6fde');
    g.clearRect(0, 0, w, h);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    const { low, high } = window_;
    const rows = high - low + 1;
    const rollTop = RULER_H;
    const rollBottom = h - (hasDrums ? DRUM_H : 0);
    const rowH = Math.max(1, (rollBottom - rollTop) / rows);
    const yOf = (pitch: number) => rollTop + (high - pitch) * rowH;
    const playX = KEY_W + (w - KEY_W) * 0.25;
    const xOf = (t: number) => playX + (t - shownTime) * pps;
    const t0 = shownTime - (playX - KEY_W) / pps;
    const t1 = shownTime + (w - playX) / pps;

    // rows (black-key rows darker, C lines)
    for (let p = low; p <= high; p++) {
      const y = yOf(p);
      if (isBlackKey(p)) {
        g.fillStyle = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.035)';
        g.fillRect(KEY_W, y, w - KEY_W, rowH);
      }
      if (p % 12 === 0) {
        g.fillStyle = border;
        g.fillRect(KEY_W, y + rowH - 0.5, w - KEY_W, 0.5);
      }
    }
    if (hasDrums) {
      g.fillStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      g.fillRect(KEY_W, rollBottom, w - KEY_W, DRUM_H);
    }

    // bars + ruler
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    if (data) {
      data.bars.forEach((bt, i) => {
        if (bt < t0 - 1 || bt > t1) return;
        const x = xOf(bt);
        g.fillStyle = border;
        g.fillRect(x, rollTop, 1, h - rollTop);
        g.fillStyle = muted;
        g.fillText(String(i + 1), x + 3, RULER_H / 2);
      });
    }
    g.fillStyle = border;
    g.fillRect(KEY_W, RULER_H - 0.5, w - KEY_W, 0.5);

    // notes
    const hits: typeof hitRef.current = [];
    const sounding = new Map<number, RollNote>();
    if (data) {
      for (const n of notesBetween(data, t0, t1)) {
        if (hidden.has(n.lane)) continue;
        const x = Math.max(KEY_W, xOf(n.start));
        const x2 = Math.min(w, xOf(n.end));
        const on = n.start <= shownTime && shownTime < n.end;
        g.globalAlpha = on ? 1 : 0.35 + 0.5 * (n.velocity / 127);
        g.fillStyle = laneColor(n.lane, n.drum, dark);
        if (n.drum) {
          const y = rollBottom + DRUM_H / 2;
          g.fillRect(x - 2, y - 3, 5, 6);
          hits.push({ x: x - 3, y: y - 4, w: 7, h: 8, note: n });
        } else {
          if (n.pitch < low || n.pitch > high) continue;
          const y = yOf(n.pitch);
          const bw = Math.max(2, x2 - x);
          g.fillRect(x, y + 0.5, bw, Math.max(1, rowH - 1));
          if (on && rowH >= 5) {
            // outline the sounding notes (thin rows: full opacity only, an outline would hide the colour)
            g.globalAlpha = 1;
            g.strokeStyle = text;
            g.lineWidth = 1;
            g.strokeRect(x + 0.5, y + 0.5, Math.max(1, bw - 1), Math.max(1, rowH - 1));
          }
          hits.push({ x, y, w: bw, h: rowH, note: n });
        }
      }
      g.globalAlpha = 1;
      for (const n of notesAt(data, shownTime)) if (!n.drum && !hidden.has(n.lane)) sounding.set(n.pitch, n);
    }
    hitRef.current = hits;

    // playhead
    g.fillStyle = accent;
    g.fillRect(playX - 0.5, 0, 1.5, h);

    // keyboard: white keys separated by thin lines, black keys shorter on top
    g.fillStyle = bg;
    g.fillRect(0, 0, KEY_W, h);
    g.fillStyle = dark ? '#5a616d' : '#b8bec8';
    g.fillRect(0, yOf(high), KEY_W - 1, rows * rowH);
    for (const black of [false, true]) {
      for (let p = low; p <= high; p++) {
        if (isBlackKey(p) !== black) continue;
        const y = yOf(p);
        const on = sounding.get(p);
        g.fillStyle = on ? laneColor(on.lane, false, dark) : black ? (dark ? '#1f232a' : '#2f343c') : dark ? '#d9dde3' : '#ffffff';
        if (black) {
          // the white keys around a black key reach the right edge
          const white = sounding.get(p - 1) ?? sounding.get(p + 1);
          g.fillStyle = white ? laneColor(white.lane, false, dark) : dark ? '#d9dde3' : '#ffffff';
          g.fillRect(KEY_W * 0.6, y, KEY_W * 0.4 - 1, Math.max(1, rowH));
          g.fillStyle = on ? laneColor(on.lane, false, dark) : dark ? '#1f232a' : '#2f343c';
          g.fillRect(0, y, KEY_W * 0.6, Math.max(1, rowH));
        }
        else g.fillRect(0, y + (rowH >= 3 ? 0.5 : 0), KEY_W - 1, Math.max(1, rowH - (rowH >= 3 ? 1 : 0)));
      }
    }
    for (let p = low; p <= high; p++) {
      const y = yOf(p);
      const on = sounding.get(p);
      if (p % 12 === 0 && rowH >= 6) {
        g.fillStyle = on ? '#ffffff' : '#555b66';
        g.font = `${Math.min(10, rowH + 1)}px system-ui, sans-serif`;
        g.fillText(pitchName(p), KEY_W - 22, y + rowH / 2);
      }
    }
    g.fillStyle = border;
    g.fillRect(KEY_W - 0.5, 0, 0.5, h);
    if (hasDrums) {
      g.fillStyle = muted;
      g.font = '10px system-ui, sans-serif';
      g.fillText('ドラム', 4, rollBottom + DRUM_H / 2);
    }
    if (!data || data.notes.length === 0) {
      g.fillStyle = muted;
      g.font = '12px system-ui, sans-serif';
      g.fillText('演奏する音符がありません', KEY_W + 12, h / 2);
    }
    const now = data ? notesAt(data, shownTime).filter((n) => !hidden.has(n.lane)).map((n) => n.pitch) : [];
    const key = [...new Set(now)].sort((a, b) => a - b).join(',');
    setActive((prev) => (prev === key ? prev : key));
  }, [data, size, pps, shownTime, window_, hasDrums, hidden]);

  const timeAt = (clientX: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const playX = KEY_W + (size.w - KEY_W) * 0.25;
    return Math.max(0, shownTime + (clientX - r.left - playX) / pps);
  };

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < KEY_W) return;
    const hit = hitRef.current.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (hit?.note.source) {
      onJump(hit.note.source);
      return;
    }
    const t = timeAt(e.clientX);
    if (canSeek) onSeek(t);
    else setViewTime(t);
  };

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    if (e.ctrlKey || e.metaKey) {
      onZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      return;
    }
    if (playing) return;
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / pps;
    const t = Math.max(0, Math.min(data?.duration ?? 0, shownTime + d));
    if (canSeek) onSeek(t);
    else setViewTime(t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = (e.shiftKey ? 400 : 80) / pps;
    let t: number | null = null;
    if (e.key === 'ArrowRight') t = shownTime + step;
    else if (e.key === 'ArrowLeft') t = Math.max(0, shownTime - step);
    else if (e.key === 'Home') t = 0;
    else if (e.key === '+' || e.key === '=') onZoom(1.25);
    else if (e.key === '-') onZoom(1 / 1.25);
    else return;
    e.preventDefault();
    if (t !== null && !playing) {
      if (canSeek) onSeek(t);
      else setViewTime(t);
    }
  };

  const count = data?.notes.length ?? 0;
  return (
    <div className="roll-canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="roll-canvas"
        role="img"
        tabIndex={0}
        aria-label={`ピアノロール（${count} 音）。クリックでその位置へ移動、音符のクリックで MML の該当箇所へ移動。左右キーで移動、＋/− で拡大縮小。`}
        data-testid="piano-roll"
        data-active={active}
        onClick={onClick}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onPointerDown={(e: PointerEvent<HTMLCanvasElement>) => e.currentTarget.focus()}
      />
    </div>
  );
}
