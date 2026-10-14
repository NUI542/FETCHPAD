import { isPunct, isWord, skipBalanced, statements, tokenize, type Token } from './tokens';

export interface SqlFacts {
  verb: string;
  reads: string[];
  writes: string[];
  /** A table name position held text only known at runtime. */
  dynamic: boolean;
  inserts: { table: string; columns: string[] }[];
}

const KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'on',
  'using', 'group', 'order', 'by', 'having', 'limit', 'offset', 'union', 'intersect', 'except', 'returning',
  'set', 'values', 'as', 'lateral', 'only', 'window', 'for', 'into', 'and', 'or', 'not', 'exists', 'case',
  'when', 'then', 'else', 'end', 'conflict', 'do', 'nothing', 'update', 'delete', 'insert', 'with',
  'recursive', 'distinct', 'all', 'asc', 'desc', 'null', 'is', 'in', 'like', 'ilike', 'between', 'default',
  'table', 'if', 'fetch', 'first', 'next', 'rows', 'row', 'top',
]);

/** Functions whose arguments use FROM without naming a table, e.g. EXTRACT(EPOCH FROM x). */
const FROM_FUNCTIONS = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);

/** Does this text start like a data statement? */
export function looksLikeSql(text: string): boolean {
  return /^\s*\(?\s*(select|insert|update|delete|with|truncate|merge|replace)\b/i.test(text);
}

/** Tables a piece of SQL reads and writes. */
export function sqlTables(sql: string): SqlFacts {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const inserts: SqlFacts['inserts'] = [];
  let dynamic = false;
  let verb = '';

  for (const stmt of statements(tokenize(sql))) {
    const ctes = new Set<string>();
    let i = 0;
    if (isWord(stmt[0], 'with')) i = readCtes(stmt, ctes);
    const main = stmt[i]?.lower ?? '';
    if (!verb) verb = main.toUpperCase();
    const local = { reads: new Set<string>(), writes: new Set<string>() };

    const readName = (k: number, allowParen: boolean): { name?: string; next: number } => {
      while (isWord(stmt[k], 'only') || isWord(stmt[k], 'lateral')) k++;
      const tk = stmt[k];
      if (!tk) return { next: k };
      if (tk.t === 'dyn') {
        dynamic = true;
        return { next: k + 1 };
      }
      if (!isName(tk)) return { next: k };
      let name = nameOf(tk);
      let schema: string | undefined;
      k++;
      while (isPunct(stmt[k], '.') && stmt[k + 1] && (isName(stmt[k + 1]) || stmt[k + 1].t === 'dyn')) {
        if (stmt[k + 1].t === 'dyn') {
          dynamic = true;
          return { next: k + 2 };
        }
        schema = name;
        name = nameOf(stmt[k + 1]);
        k += 2;
      }
      if (!allowParen && isPunct(stmt[k], '(')) return { next: k }; // a function, not a table
      if (isSystemTable(schema, name)) return { next: k };
      return { name, next: k };
    };

    const readList = (k: number, into: Set<string>): void => {
      for (;;) {
        const { name, next } = readName(k, false);
        if (!name) return;
        into.add(name);
        k = next;
        if (isWord(stmt[k], 'as')) k++;
        if (stmt[k] && isName(stmt[k])) k++; // alias
        if (!isPunct(stmt[k], ',')) return;
        k++;
      }
    };

    const owners: string[] = [];
    for (let j = 0; j < stmt.length; j++) {
      const tk = stmt[j];
      if (isPunct(tk, '(')) {
        const before = stmt[j - 1];
        owners.push(before?.t === 'word' ? before.lower : '');
        continue;
      }
      if (isPunct(tk, ')')) {
        owners.pop();
        continue;
      }
      if (tk.t !== 'word') continue;
      const prev = stmt[j - 1]?.t === 'word' ? stmt[j - 1].lower : '';
      switch (tk.lower) {
        case 'from':
          if (FROM_FUNCTIONS.has(owners[owners.length - 1] ?? '') || prev === 'distinct') break;
          if (prev === 'delete') {
            const { name } = readName(j + 1, false);
            if (name) local.writes.add(name);
          } else {
            readList(j + 1, local.reads);
          }
          break;
        case 'join': {
          const { name } = readName(j + 1, false);
          if (name) local.reads.add(name);
          break;
        }
        case 'into':
          if (prev === 'insert' || prev === 'replace' || prev === 'or') {
            const { name, next } = readName(j + 1, true);
            if (name) {
              local.writes.add(name);
              inserts.push({ table: name, columns: isPunct(stmt[next], '(') ? columnList(stmt, next) : [] });
            }
          }
          break;
        case 'update':
          if (['do', 'for', 'key', 'on'].includes(prev)) break; // ON CONFLICT DO UPDATE, FOR UPDATE, ON UPDATE
          {
            const { name } = readName(j + 1, false);
            if (name) local.writes.add(name);
          }
          break;
        case 'using':
          if (main === 'delete' && !isPunct(stmt[j + 1], '(')) readList(j + 1, local.reads);
          break;
        case 'truncate': {
          let k = j + 1;
          if (isWord(stmt[k], 'table')) k++;
          readList(k, local.writes);
          break;
        }
      }
    }
    for (const t of local.reads) if (!ctes.has(t)) reads.add(t);
    for (const t of local.writes) if (!ctes.has(t)) writes.add(t);
  }
  return { verb, reads: [...reads].sort(), writes: [...writes].sort(), dynamic, inserts };
}

/** WITH [RECURSIVE] a AS (...), b AS (...): returns the index of the main statement. */
function readCtes(stmt: Token[], ctes: Set<string>): number {
  let i = 1;
  if (isWord(stmt[i], 'recursive')) i++;
  while (i < stmt.length && isName(stmt[i])) {
    ctes.add(nameOf(stmt[i]));
    i++;
    if (isPunct(stmt[i], '(')) i = skipBalanced(stmt, i);
    if (!isWord(stmt[i], 'as')) break;
    i++;
    if (isWord(stmt[i], 'not')) i++;
    if (isWord(stmt[i], 'materialized')) i++;
    if (!isPunct(stmt[i], '(')) break;
    i = skipBalanced(stmt, i);
    if (!isPunct(stmt[i], ',')) break;
    i++;
  }
  return i;
}

function columnList(stmt: Token[], open: number): string[] {
  const end = skipBalanced(stmt, open) - 1;
  const out: string[] = [];
  for (let k = open + 1; k < end; k++) if (isName(stmt[k]) || stmt[k].t === 'word') out.push(nameOf(stmt[k]));
  return out;
}

/** Database catalogs (Postgres, SQLite) are not part of the app's data model. */
function isSystemTable(schema: string | undefined, name: string): boolean {
  return schema === 'information_schema' || schema === 'pg_catalog'
    || /^pg_/.test(name) || /^sqlite_/.test(name);
}

export function isName(tk: Token | undefined): boolean {
  return !!tk && (tk.t === 'qword' || (tk.t === 'word' && !KEYWORDS.has(tk.lower)));
}

/** Unquoted identifiers fold to lower case; quoted ones keep their case. */
export function nameOf(tk: Token): string {
  return tk.t === 'qword' ? tk.v : tk.lower;
}
