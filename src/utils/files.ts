/** Triggers a browser download of local data. Nothing is uploaded anywhere. */
export function downloadBytes(data: BlobPart, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function baseName(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const name = fileName.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || 'song';
}

/** Strict UTF-8 decode with BOM removal; throws on invalid sequences. */
export async function readUtf8(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Text in UTF-8, or Shift_JIS when it is not valid UTF-8 (MML written for the Windows versions of
 * other players, e.g. the Sakura MML board downloads). Throws when neither decodes.
 */
export async function readTextUtf8OrSjis(file: File): Promise<{ text: string; encoding: 'utf-8' | 'shift_jis' }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: 'utf-8' };
  } catch {
    const text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
    return { text, encoding: 'shift_jis' };
  }
}
