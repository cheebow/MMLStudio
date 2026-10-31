// Colours shared by the piano roll and the channel monitor (SPEC 6.3).

/** Track colours: evenly spread hues, readable on light and dark backgrounds. */
export function laneColor(lane: number, drum: boolean, dark: boolean): string {
  if (drum) return dark ? '#9aa4b2' : '#6b7280';
  const hue = (lane * 137.508 + 210) % 360;
  return `hsl(${hue.toFixed(0)} 70% ${dark ? 62 : 46}%)`;
}

export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
