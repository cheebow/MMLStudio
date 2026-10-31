import type { Diagnostic } from '../engine';

interface Props {
  diagnostics: Diagnostic[];
  onJump: (d: Diagnostic) => void;
}

export function DiagnosticsPanel({ diagnostics, onJump }: Props) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  return (
    <section className="panel diagnostics" aria-labelledby="diag-title">
      <h2 id="diag-title">
        エラー・警告 <span className="count">（エラー {errors} / 警告 {warnings}）</span>
      </h2>
      {diagnostics.length === 0 ? (
        <p className="muted">問題はありません。</p>
      ) : (
        <ul className="diag-list">
          {diagnostics.map((d, i) => (
            <li key={`${d.span.startOffset}-${d.code}-${i}`}>
              <button type="button" className={`diag diag-${d.severity}`} onClick={() => onJump(d)}>
                <span className="diag-icon" aria-hidden="true">
                  {d.severity === 'error' ? '✖' : '⚠'}
                </span>
                <span className="diag-kind">{d.severity === 'error' ? 'エラー' : '警告'}</span>
                <span className="diag-pos">
                  {d.span.startLine}行{d.span.startColumn}列
                </span>
                <span className="diag-msg">{d.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
