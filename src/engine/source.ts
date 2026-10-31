import type { Diagnostic, SourceSpan } from './types';

/** Maps UTF-16 offsets to 1-based line/column positions. */
export class SourceMap {
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.lineStarts[lo] + 1 };
  }

  span(start: number, end: number): SourceSpan {
    const s = this.position(start);
    const e = this.position(end);
    return {
      startOffset: start,
      endOffset: end,
      startLine: s.line,
      startColumn: s.column,
      endLine: e.line,
      endColumn: e.column,
    };
  }
}

export function mergeSpans(a: SourceSpan, b: SourceSpan): SourceSpan {
  const first = a.startOffset <= b.startOffset ? a : b;
  const last = a.endOffset >= b.endOffset ? a : b;
  return {
    startOffset: first.startOffset,
    startLine: first.startLine,
    startColumn: first.startColumn,
    endOffset: last.endOffset,
    endLine: last.endLine,
    endColumn: last.endColumn,
  };
}

export function error(code: string, message: string, span: SourceSpan): Diagnostic {
  return { code, severity: 'error', message, span };
}

export function warning(code: string, message: string, span: SourceSpan): Diagnostic {
  return { code, severity: 'warning', message, span };
}

/** UTF-8 byte length without relying on TextEncoder (keeps the engine lib-free). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
