// Draft persistence in localStorage (SPEC 6.1). Every access is guarded: storage may be
// unavailable (private mode, blocked cookies) and the app must work without it.
const KEY = 'mml-studio:draft:v1';

export interface Draft {
  source: string;
  fileName: string | null;
  savedAt: number;
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.source !== 'string') return null;
    return { source: d.source, fileName: typeof d.fileName === 'string' ? d.fileName : null, savedAt: Number(d.savedAt) || 0 };
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
