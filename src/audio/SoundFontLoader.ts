export const DEFAULT_SOUNDFONT_URL = `${import.meta.env.BASE_URL}soundfonts/GeneralUser-GS.sf2`;
export const WORKLET_URL = `${import.meta.env.BASE_URL}spessasynth_processor.min.js`;

export class SoundFontFetchError extends Error {
  constructor(
    readonly kind: 'not-found' | 'http' | 'network',
    message: string,
  ) {
    super(message);
  }
}

/** Fetches the bundled SoundFont, reporting progress (0..1, or null when unknown). */
export async function fetchSoundFont(
  url: string,
  onProgress?: (ratio: number | null) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new SoundFontFetchError('network', `標準 SoundFont を取得できませんでした（ネットワーク/CORS）: ${url}`);
  }
  if (res.status === 404) {
    throw new SoundFontFetchError(
      'not-found',
      `標準 SoundFont が見つかりません（404）: ${url}。開発環境では "npm run fetch-soundfont" を実行するか、ローカル SF2 を読み込んでください。`,
    );
  }
  if (!res.ok) throw new SoundFontFetchError('http', `標準 SoundFont の取得に失敗しました（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    onProgress?.(null);
    return res.arrayBuffer();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(total ? Math.min(1, received / total) : null);
  }
  const out = new Uint8Array(new ArrayBuffer(received));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
