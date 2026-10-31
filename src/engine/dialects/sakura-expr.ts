// Integer / string expressions of Sakura MML programs (SPEC 4.5.12): `BGN-1`, `X6*10`, `CH==2`, `$10+_CH`, `MML(v)`.
// Hand-written; values are numbers or strings. Integer division truncates (Sakura `Int`).

export type SValue = number | string;

export class ExprError extends Error {}

export interface ExprEnv {
  /** variable or special name -> value; undefined when unknown */
  lookup(name: string): SValue | undefined;
  /** function call with raw argument texts; undefined when unknown */
  call(name: string, args: string[]): SValue | undefined;
  /** `!4`, `!8.`, `!1^1`: a note length as a number of steps; undefined when unknown */
  noteLength?(text: string): number | undefined;
}

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'id'; v: string; args?: string[] } | { k: 'op'; v: string };

const OPS2 = ['==', '!=', '<=', '>=', '&&', '||', '<>'];

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '{') depth++;
    if (ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

function tokenize(s: string, env?: ExprEnv): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let n = '';
      while (i < s.length && (/[0-9]/.test(s[i]) || (s[i] === '.' && /[0-9]/.test(s[i + 1] ?? '')))) n += s[i++];
      t.push({ k: 'num', v: Number(n) });
      continue;
    }
    if (c === '!' && /[0-9]/.test(s[i + 1] ?? '')) {
      let len = '';
      i++;
      while (i < s.length && /[0-9.^]/.test(s[i])) len += s[i++];
      const v = env?.noteLength?.(len);
      if (v === undefined) throw new ExprError(`音長 !${len} を読めません`);
      t.push({ k: 'num', v });
      continue;
    }
    if (c === '$') {
      let h = '';
      i++;
      while (i < s.length && /[0-9A-Fa-f]/.test(s[i])) h += s[i++];
      if (!h) throw new ExprError('$ の後に 16 進数が必要です');
      t.push({ k: 'num', v: parseInt(h, 16) });
      continue;
    }
    if (c === '{') {
      let depth = 0;
      let k = i;
      for (; k < s.length; k++) {
        if (s[k] === '{') depth++;
        else if (s[k] === '}' && --depth === 0) break;
      }
      if (k >= s.length) throw new ExprError('{ が } で閉じられていません');
      let v = s.slice(i + 1, k);
      if (/^".*"$/s.test(v)) v = v.slice(1, -1);
      t.push({ k: 'str', v });
      i = k + 1;
      continue;
    }
    if (c === '"') {
      const k = s.indexOf('"', i + 1);
      if (k < 0) throw new ExprError('" が閉じられていません');
      t.push({ k: 'str', v: s.slice(i + 1, k) });
      i = k + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < s.length && /[A-Za-z0-9_.]/.test(s[i])) id += s[i++];
      let j = i;
      while (j < s.length && /[ \t]/.test(s[j])) j++;
      if (s[j] === '(') {
        let depth = 0;
        let k = j;
        for (; k < s.length; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')' && --depth === 0) break;
        }
        if (k >= s.length) throw new ExprError('( が ) で閉じられていません');
        t.push({ k: 'id', v: id, args: splitArgs(s.slice(j + 1, k)) });
        i = k + 1;
      } else t.push({ k: 'id', v: id });
      continue;
    }
    const two = s.slice(i, i + 2);
    if (OPS2.includes(two)) {
      t.push({ k: 'op', v: two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }
    if ('+-*/%<>!()='.includes(c)) {
      t.push({ k: 'op', v: c === '=' ? '==' : c });
      i++;
      continue;
    }
    throw new ExprError(`式に使えない文字「${c}」があります`);
  }
  return t;
}

const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

const truthy = (v: SValue) => (typeof v === 'number' ? v !== 0 : v !== '');
const toNum = (v: SValue): number => {
  if (typeof v === 'number') return v;
  if (/^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  throw new ExprError(`文字列「${v}」を数値として使えません`);
};

export function evalExpr(text: string, env: ExprEnv): SValue {
  const toks = tokenize(text, env);
  if (toks.length === 0) throw new ExprError('式がありません');
  let pos = 0;
  const primary = (): SValue => {
    const t = toks[pos++];
    if (!t) throw new ExprError('式が途中で終わっています');
    if (t.k === 'num' || t.k === 'str') return t.v;
    if (t.k === 'op') {
      if (t.v === '(') {
        const v = binary(0);
        if (toks[pos]?.k !== 'op' || toks[pos].v !== ')') throw new ExprError(') がありません');
        pos++;
        return v;
      }
      if (t.v === '-') return -toNum(primary());
      if (t.v === '+') return toNum(primary());
      if (t.v === '!') return truthy(primary()) ? 0 : 1;
      throw new ExprError(`「${t.v}」の位置が正しくありません`);
    }
    if (t.args) {
      const v = env.call(t.v, t.args);
      if (v === undefined) throw new ExprError(`関数 ${t.v}() は変換時に計算できません`);
      return v;
    }
    const v = env.lookup(t.v);
    if (v === undefined) throw new ExprError(`${t.v} の値が分かりません（未定義の名前）`);
    return v;
  };
  const binary = (min: number): SValue => {
    let left = primary();
    for (;;) {
      const t = toks[pos];
      if (!t || t.k !== 'op' || !(t.v in PREC) || PREC[t.v] < min) return left;
      pos++;
      const right = binary(PREC[t.v] + 1);
      left = apply(t.v, left, right);
    }
  };
  const v = binary(0);
  if (pos < toks.length) throw new ExprError('式の後に余分な文字があります');
  return v;
}

function apply(op: string, a: SValue, b: SValue): SValue {
  switch (op) {
    case '+':
      return typeof a === 'string' && typeof b === 'string' ? a + b : toNum(a) + toNum(b);
    case '-':
      return toNum(a) - toNum(b);
    case '*':
      return toNum(a) * toNum(b);
    case '/':
    case '%': {
      const x = toNum(a);
      const y = toNum(b);
      if (y === 0) throw new ExprError('0 で割っています');
      if (op === '%') return x % y;
      return Number.isInteger(x) && Number.isInteger(y) ? Math.trunc(x / y) : x / y;
    }
    case '==':
      return (typeof a === 'string' || typeof b === 'string' ? String(a) === String(b) : a === b) ? 1 : 0;
    case '!=':
      return (typeof a === 'string' || typeof b === 'string' ? String(a) !== String(b) : a !== b) ? 1 : 0;
    case '<':
      return toNum(a) < toNum(b) ? 1 : 0;
    case '>':
      return toNum(a) > toNum(b) ? 1 : 0;
    case '<=':
      return toNum(a) <= toNum(b) ? 1 : 0;
    case '>=':
      return toNum(a) >= toNum(b) ? 1 : 0;
    case '&&':
      return truthy(a) && truthy(b) ? 1 : 0;
    case '||':
      return truthy(a) || truthy(b) ? 1 : 0;
  }
  throw new ExprError(`演算子 ${op} は使えません`);
}

export { truthy, toNum };
