// MML Studio tokenizer (SPEC 3.1). Hand-written; no external MML code.
import { error, SourceMap } from './source';
import type { Diagnostic, SourceSpan } from './types';

export type Keyword =
  | 'channel'
  | 'tempous'
  | 'tempo'
  | 'track'
  | 'time'
  | 'sub'
  | 'tr'
  | 'ch'
  | 'cc'
  | 'pb';

interface TokenBase {
  span: SourceSpan;
  /** true when whitespace/comment/separator precedes this token */
  spaceBefore: boolean;
}

export type Token =
  | (TokenBase & { type: 'keyword'; value: Keyword; text: string })
  | (TokenBase & { type: 'letter'; value: string; text: string })
  | (TokenBase & { type: 'number'; value: number; text: string })
  | (TokenBase & { type: 'symbol'; value: string })
  | (TokenBase & { type: 'eof' });

/**
 * Multi-letter commands, longest first. A keyword is recognised only when it is followed
 * (optionally after spaces/tabs) by the character that introduces its argument, so that
 * e.g. `cc4` stays two C notes while `CC(64,0)` is a control change (DECISIONS D-006).
 */
const KEYWORDS: ReadonlyArray<{ word: Keyword; next: string }> = [
  { word: 'channel', next: '(' },
  { word: 'tempous', next: '(' },
  { word: 'tempo', next: '(' },
  { word: 'track', next: '(' },
  { word: 'time', next: '(' },
  { word: 'sub', next: '{' },
  { word: 'tr', next: '(=' },
  { word: 'ch', next: '(=' },
  { word: 'cc', next: '(' },
  { word: 'pb', next: '(' },
];

const SYMBOLS = new Set(['(', ')', '=', ',', ':', '+', '#', '-', '.', '^', '&', '>', '<', '@', '%', "'", '{', '}', '[', ']']);

function isLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isSeparator(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';';
}

export interface TokenizeResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
  map: SourceMap;
}

export function tokenize(source: string, map = new SourceMap(source)): TokenizeResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const n = source.length;
  let i = 0;
  let spaceBefore = true;

  while (i < n) {
    const c = source[i];
    if (isSeparator(c)) {
      i++;
      spaceBefore = true;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      spaceBefore = true;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) {
        diagnostics.push(error('E_UNTERMINATED_COMMENT', 'ブロックコメント /* が */ で閉じられていません。', map.span(i, i + 2)));
        break;
      }
      i = end + 2;
      spaceBefore = true;
      continue;
    }
    const start = i;
    if (isLetter(c)) {
      const kw = matchKeyword(source, i);
      if (kw) {
        i += kw.length;
        tokens.push({ type: 'keyword', value: kw, text: source.slice(start, i), span: map.span(start, i), spaceBefore });
      } else {
        i++;
        tokens.push({ type: 'letter', value: c.toLowerCase(), text: c, span: map.span(start, i), spaceBefore });
      }
    } else if (isDigit(c)) {
      while (i < n && isDigit(source[i])) i++;
      const text = source.slice(start, i);
      // Very long digit runs are clamped; range checks report them as out of range.
      const value = text.length > 15 ? Number.MAX_SAFE_INTEGER : Number(text);
      tokens.push({ type: 'number', value, text, span: map.span(start, i), spaceBefore });
    } else if (SYMBOLS.has(c)) {
      i++;
      tokens.push({ type: 'symbol', value: c, span: map.span(start, i), spaceBefore });
    } else {
      // Group a run of invalid characters into one diagnostic.
      while (i < n && !isLetter(source[i]) && !isDigit(source[i]) && !isSeparator(source[i]) && !SYMBOLS.has(source[i]) && source[i] !== '/') {
        i++;
      }
      if (i === start) i++; // lone '/'
      const text = source.slice(start, i);
      diagnostics.push(error('E_INVALID_CHAR', `使用できない文字です: "${text}"`, map.span(start, i)));
    }
    spaceBefore = false;
  }
  tokens.push({ type: 'eof', span: map.span(n, n), spaceBefore: true });
  return { tokens, diagnostics, map };
}

function matchKeyword(source: string, i: number): Keyword | null {
  for (const { word, next } of KEYWORDS) {
    if (source.slice(i, i + word.length).toLowerCase() !== word) continue;
    let j = i + word.length;
    while (source[j] === ' ' || source[j] === '\t') j++;
    if (j < source.length && next.includes(source[j])) return word;
  }
  return null;
}
