/** Placeholder for a piece of SQL text only known at runtime (a `${...}` in a template). */
export const DYN = '\u0001';

export interface Token {
  t: 'word' | 'qword' | 'str' | 'num' | 'param' | 'dyn' | 'punct';
  /** Source text; for quoted identifiers, the name without quotes. */
  v: string;
  lower: string;
  pos: number;
  end: number;
}

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const push = (t: Token['t'], start: number, end: number, v = sql.slice(start, end)) =>
    out.push({ t, v, lower: v.toLowerCase(), pos: start, end });
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? sql.length : e + 2;
      continue;
    }
    const start = i;
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push('str', start, i);
      continue;
    }
    if (c === '$') {
      if (/[0-9]/.test(sql[i + 1] ?? '')) {
        i++;
        while (/[0-9]/.test(sql[i] ?? '')) i++;
        push('param', start, i);
        continue;
      }
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? sql.length : e + tag.length;
        push('str', start, i);
        continue;
      }
    }
    if (c === '"' || c === '`') {
      i++;
      while (i < sql.length && sql[i] !== c) i++;
      i++;
      push('qword', start, i, sql.slice(start + 1, i - 1));
      continue;
    }
    if (c === DYN) {
      i++;
      push('dyn', start, i);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      push('word', start, i);
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9.]/.test(sql[i])) i++;
      push('num', start, i);
      continue;
    }
    if (c === ':' && sql[i + 1] === ':') {
      i += 2;
      push('punct', start, i);
      continue;
    }
    if (c === '?') {
      i++;
      push('param', start, i);
      continue;
    }
    i++;
    push('punct', start, i);
  }
  return out;
}

/** Split at top-level `;`. */
export function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (const tk of tokens) {
    if (tk.t === 'punct' && tk.v === ';') {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(tk);
    }
  }
  if (current.length) out.push(current);
  return out;
}

export const isWord = (tk: Token | undefined, w: string): boolean => tk?.t === 'word' && tk.lower === w;
export const isPunct = (tk: Token | undefined, p: string): boolean => tk?.t === 'punct' && tk.v === p;

/** Index just past the `)` matching the `(` at `i`. */
export function skipBalanced(tokens: Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (isPunct(tokens[j], '(')) depth++;
    else if (isPunct(tokens[j], ')')) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length;
}

/** 1-based line and column of each offset in `text`. */
export function lineIndex(text: string): (offset: number) => { line: number; col: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 };
  };
}
