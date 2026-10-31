import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import type { Diagnostic } from '../engine';

interface MmlState {
  inBlockComment: boolean;
}

// Highlighting only; the real parser lives in src/engine.
const mmlParser: StreamParser<MmlState> = {
  name: 'mml',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) {
        stream.pos += 2;
        state.inBlockComment = false;
      } else stream.skipToEnd();
      return 'blockComment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'lineComment';
    }
    if (stream.match('/*')) {
      state.inBlockComment = true;
      return 'blockComment';
    }
    if (stream.match(/^(channel|tempous|tempo|track|time|tr|ch|cc|pb)(?=\s*[(=])/i)) return 'keyword';
    if (stream.match(/^sub(?=\s*\{)/i)) return 'keyword';
    if (stream.match(/^[cdefgab][+#-]?/i)) return 'atom';
    if (stream.match(/^[rR]/)) return 'comment';
    if (stream.match(/^[nN]\d*/)) return 'atom';
    if (stream.match(/^[olvqtOLVQT@]/)) return 'propertyName';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^[<>^&.%']/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
};

const mmlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: tags.atom, color: 'var(--syn-note)' },
  { tag: tags.propertyName, color: 'var(--syn-command)' },
  { tag: tags.number, color: 'var(--syn-number)' },
  { tag: tags.operator, color: 'var(--syn-operator)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.comment, color: 'var(--syn-rest)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--editor-gutter)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active)' },
  '&.cm-focused': { outline: '2px solid var(--focus)' },
  '.cm-content': { caretColor: 'var(--text)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
});

export interface MmlEditorHandle {
  setValue: (text: string) => void;
  getValue: () => string;
  jumpTo: (from: number, to: number) => void;
  focus: () => void;
}

interface Props {
  initialValue: string;
  diagnostics: Diagnostic[];
  onChange: (text: string) => void;
}

export const MmlEditor = forwardRef<MmlEditorHandle, Props>(function MmlEditor({ initialValue, diagnostics, onChange }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialRef = useRef(initialValue);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: initialRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          StreamLanguage.define(mmlParser),
          syntaxHighlighting(mmlHighlight),
          lintGutter(),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'MML エディタ' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const len = view.state.doc.length;
    const cm: CmDiagnostic[] = diagnostics.map((d) => {
      const from = Math.min(d.span.startOffset, len);
      const to = Math.min(Math.max(d.span.endOffset, from), len);
      return { from, to, severity: d.severity, message: d.message, source: d.code };
    });
    view.dispatch(setDiagnostics(view.state, cm));
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    setValue(text: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    },
    getValue() {
      return viewRef.current?.state.doc.toString() ?? '';
    },
    jumpTo(from: number, to: number) {
      const view = viewRef.current;
      if (!view) return;
      const len = view.state.doc.length;
      const anchor = Math.min(from, len);
      const head = Math.min(Math.max(to, anchor), len);
      view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
      view.focus();
    },
    focus() {
      viewRef.current?.focus();
    },
  }));

  return <div className="editor-host" ref={hostRef} />;
});
