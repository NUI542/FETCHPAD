import * as fs from 'fs';
import * as ts from 'typescript';
import type { SourceRange } from '../../model/types';
import type { GraphBuilder } from '../graph';
import { rangeOf, relPath, type Project } from '../project';
import { parseSchema } from '../sql/schema';
import { looksLikeSql, sqlTables } from '../sql/tables';
import { DYN, lineIndex } from '../sql/tokens';
import { evalString, render } from '../strings';
import type { UnitIndex } from '../units';

/** Method names that take SQL text as their first argument (pg, mysql2, sqlite, better-sqlite3). */
const SQL_METHODS = new Set(['query', 'execute', 'prepare', 'exec', 'run', 'all', 'get', 'each']);

export const tableId = (name: string) => `sql:${name}:table`;
export const columnId = (table: string, column: string) => `sql:${table}.${column}:column`;

/** Tables, columns and foreign keys from the project's .sql files. Returns how many tables were found. */
export function analyzeSchema(project: Project, graph: GraphBuilder): number {
  let count = 0;
  for (const abs of project.sqlFiles) {
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const file = relPath(project.root, abs);
    const at = lineIndex(text);
    const range = (pos: number, end: number): SourceRange => {
      const s = at(pos);
      const e = at(end);
      return { file, startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col };
    };

    for (const table of parseSchema(text)) {
      count++;
      const id = tableId(table.name);
      graph.addNode({
        id,
        kind: 'table',
        name: table.name,
        ranges: [range(table.pos, table.end)],
        lang: 'sql',
        meta: { inSchema: true, columns: table.columns.map((c) => c.name) },
      });
      for (const col of table.columns) {
        graph.addNode({
          id: columnId(table.name, col.name),
          kind: 'column',
          name: col.name,
          parent: id,
          ranges: [range(col.pos, col.end)],
          lang: 'sql',
          meta: { type: col.type },
        });
      }
      for (const fk of table.foreignKeys) {
        graph.addEdge({
          from: id,
          to: tableId(fk.refTable),
          kind: 'references',
          label: `${fk.columns.join(', ')} → ${fk.refTable}${fk.refColumns.length ? `(${fk.refColumns.join(', ')})` : ''}`,
          evidence: range(fk.pos, fk.end),
          resolved: true,
        });
      }
    }
  }
  return count;
}

/** Which tables each function reads and writes, from the SQL text it passes to the database. */
export function analyzeSqlUsage(project: Project, units: UnitIndex, graph: GraphBuilder, schemaTables: number): void {
  const { checker } = project;
  const ensureTable = (name: string, evidence: SourceRange): string => {
    const id = tableId(name);
    if (!graph.getNode(id)) {
      graph.addNode({ id, kind: 'table', name, ranges: [], lang: 'sql', meta: { inSchema: false } });
      if (schemaTables > 0) {
        graph.addGap({ kind: 'unknown-table', message: `Table "${name}" is used in code but not defined in any .sql file`, evidence });
      }
    }
    return id;
  };

  for (const unit of units.list) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && SQL_METHODS.has(node.expression.name.text) && node.arguments.length) {
        const text = render(evalString({ checker, notes: [] }, node.arguments[0]), DYN);
        if (looksLikeSql(text)) {
          const facts = sqlTables(text);
          const evidence = rangeOf(project, node);
          for (const t of facts.writes) {
            graph.addEdge({ from: unit.id, to: ensureTable(t, evidence), kind: 'writes', label: facts.verb, evidence, resolved: true });
          }
          for (const t of facts.reads) {
            graph.addEdge({ from: unit.id, to: ensureTable(t, evidence), kind: 'reads', label: facts.verb, evidence, resolved: true });
          }
          if (facts.dynamic) {
            graph.addGap({ kind: 'dynamic-sql', message: `${unit.name}: a table name in this query is built at runtime`, evidence });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(unit.node);
  }
}
