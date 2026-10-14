import { isName, nameOf } from './tables';
import { isPunct, isWord, skipBalanced, statements, tokenize, type Token } from './tokens';

export interface Span {
  pos: number;
  end: number;
}

export interface ColumnDef extends Span {
  name: string;
  type: string;
}

export interface ForeignKey extends Span {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface TableDef extends Span {
  name: string;
  columns: ColumnDef[];
  foreignKeys: ForeignKey[];
}

const TABLE_CONSTRAINTS = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'exclude', 'like']);

/** CREATE TABLE and ALTER TABLE ... ADD COLUMN / FOREIGN KEY from a schema file. */
export function parseSchema(text: string): TableDef[] {
  const tables = new Map<string, TableDef>();
  for (const stmt of statements(tokenize(text))) {
    if (isWord(stmt[0], 'create')) {
      const def = createTable(stmt);
      if (def) tables.set(def.name, def);
    } else if (isWord(stmt[0], 'alter') && isWord(stmt[1], 'table')) {
      alterTable(stmt, tables);
    }
  }
  return [...tables.values()];
}

function createTable(stmt: Token[]): TableDef | undefined {
  let i = 1;
  if (isWord(stmt[i], 'or') && isWord(stmt[i + 1], 'replace')) i += 2;
  while (['temp', 'temporary', 'unlogged', 'global', 'local'].includes(stmt[i]?.lower ?? '')) i++;
  if (!isWord(stmt[i], 'table')) return undefined;
  i++;
  if (isWord(stmt[i], 'if') && isWord(stmt[i + 1], 'not') && isWord(stmt[i + 2], 'exists')) i += 3;
  const named = qualifiedName(stmt, i);
  if (!named) return undefined;
  i = named.next;
  if (!isPunct(stmt[i], '(')) return undefined;
  const close = skipBalanced(stmt, i) - 1;
  const def: TableDef = { name: named.name, columns: [], foreignKeys: [], pos: stmt[0].pos, end: stmt[close]?.end ?? stmt[stmt.length - 1].end };
  for (const item of splitTopLevel(stmt.slice(i + 1, close))) {
    if (!item.length) continue;
    if (TABLE_CONSTRAINTS.has(item[0].lower)) {
      const fk = foreignKey(item);
      if (fk) def.foreignKeys.push(fk);
      continue;
    }
    addColumn(def, item);
  }
  return def;
}

function alterTable(stmt: Token[], tables: Map<string, TableDef>): void {
  let i = 2;
  if (isWord(stmt[i], 'if') && isWord(stmt[i + 1], 'exists')) i += 2;
  if (isWord(stmt[i], 'only')) i++;
  const named = qualifiedName(stmt, i);
  if (!named) return;
  const def = tables.get(named.name);
  if (!def) return;
  for (const action of splitTopLevel(stmt.slice(named.next))) {
    if (!isWord(action[0], 'add')) continue;
    let k = 1;
    if (isWord(action[k], 'column')) k++;
    if (isWord(action[k], 'if') && isWord(action[k + 1], 'not') && isWord(action[k + 2], 'exists')) k += 3;
    const rest = action.slice(k);
    if (!rest.length) continue;
    if (TABLE_CONSTRAINTS.has(rest[0].lower)) {
      const fk = foreignKey(rest);
      if (fk) def.foreignKeys.push(fk);
    } else {
      addColumn(def, rest);
    }
  }
}

function addColumn(def: TableDef, item: Token[]): void {
  if (!isName(item[0]) && item[0].t !== 'word') return;
  const name = nameOf(item[0]);
  const typeTokens: string[] = [];
  for (let k = 1; k < item.length; k++) {
    if (['not', 'null', 'default', 'primary', 'references', 'unique', 'check', 'constraint', 'generated', 'collate'].includes(item[k].lower)) break;
    typeTokens.push(item[k].v);
  }
  def.columns.push({ name, type: typeTokens.join(' ').replace(/\s*([(),])\s*/g, '$1'), pos: item[0].pos, end: item[item.length - 1].end });
  const ref = item.findIndex((tk) => isWord(tk, 'references'));
  if (ref >= 0) {
    const target = references(item, ref);
    if (target) def.foreignKeys.push({ columns: [name], ...target, pos: item[ref].pos, end: item[item.length - 1].end });
  }
}

function foreignKey(item: Token[]): ForeignKey | undefined {
  const fk = item.findIndex((tk) => isWord(tk, 'foreign'));
  const ref = item.findIndex((tk) => isWord(tk, 'references'));
  if (fk < 0 || ref < 0) return undefined;
  const open = item.findIndex((tk, k) => k > fk && isPunct(tk, '('));
  const columns = open >= 0 ? names(item.slice(open + 1, skipBalanced(item, open) - 1)) : [];
  const target = references(item, ref);
  return target ? { columns, ...target, pos: item[0].pos, end: item[item.length - 1].end } : undefined;
}

function references(item: Token[], ref: number): { refTable: string; refColumns: string[] } | undefined {
  const named = qualifiedName(item, ref + 1);
  if (!named) return undefined;
  const open = named.next;
  const refColumns = isPunct(item[open], '(') ? names(item.slice(open + 1, skipBalanced(item, open) - 1)) : [];
  return { refTable: named.name, refColumns };
}

function qualifiedName(tokens: Token[], i: number): { name: string; next: number } | undefined {
  const first = tokens[i];
  if (!first || (first.t !== 'word' && first.t !== 'qword')) return undefined;
  let name = nameOf(first);
  i++;
  while (isPunct(tokens[i], '.') && tokens[i + 1] && (tokens[i + 1].t === 'word' || tokens[i + 1].t === 'qword')) {
    name = nameOf(tokens[i + 1]);
    i += 2;
  }
  return { name, next: i };
}

function names(tokens: Token[]): string[] {
  return tokens.filter((tk) => tk.t === 'word' || tk.t === 'qword').map(nameOf);
}

function splitTopLevel(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const tk of tokens) {
    if (isPunct(tk, '(')) depth++;
    if (isPunct(tk, ')')) depth--;
    if (depth === 0 && isPunct(tk, ',')) {
      out.push(current);
      current = [];
      continue;
    }
    current.push(tk);
  }
  out.push(current);
  return out;
}
