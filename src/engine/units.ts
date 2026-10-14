import * as ts from 'typescript';
import type { GraphBuilder } from './graph';
import { isProjectFile, langOf, rangeOf, relPath, type Project } from './project';
import { isFunctionLike, type FunctionLike } from './resolve';

/**
 * A unit is a function that gets its own block on the map: any function not
 * nested inside another function. Nested functions (event handlers inside a
 * component, callbacks) belong to the unit that contains them.
 */
export interface Unit {
  id: string;
  name: string;
  kind: 'function' | 'component';
  node: FunctionLike;
  file: string;
}

export class UnitIndex {
  readonly list: Unit[] = [];
  private byNode = new Map<ts.Node, Unit>();

  constructor(private project: Project, graph: GraphBuilder) {
    for (const sf of project.program.getSourceFiles()) {
      if (!isProjectFile(project, sf)) continue;
      const file = relPath(project.root, sf.fileName);
      const fileId = `file:${file}`;
      graph.addNode({
        id: fileId,
        kind: 'file',
        name: file.split('/').pop()!,
        ranges: [{ file, startLine: 1, startCol: 1, endLine: sf.getLineAndCharacterOfPosition(sf.end).line + 1, endCol: 1 }],
        lang: langOf(sf.fileName),
      });

      const taken = new Map<string, number>();
      const test = isTestFile(file);
      const visit = (node: ts.Node): void => {
        if (isFunctionLike(node) && node.body) {
          const unit = this.makeUnit(sf, file, node, taken);
          graph.addNode({
            id: unit.id,
            kind: unit.kind,
            name: unit.name,
            parent: fileId,
            ranges: [rangeOf(project, node)],
            lang: langOf(sf.fileName),
            meta: test ? { test: true } : undefined,
          });
          return; // functions nested inside are part of this unit
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(sf, visit);
    }
  }

  private makeUnit(sf: ts.SourceFile, file: string, node: FunctionLike, taken: Map<string, number>): Unit {
    let name = unitName(node);
    const seen = taken.get(name) ?? 0;
    taken.set(name, seen + 1);
    if (seen > 0) name = `${name}#${seen + 1}`;
    const last = name.split('.').pop() ?? name;
    const isComponent = /^[A-Z]/.test(last) && (/\.(jsx|tsx)$/.test(sf.fileName) || containsJsx(node));
    const kind = isComponent ? 'component' : 'function';
    const unit: Unit = { id: `${langOf(sf.fileName)}:${file}#${name}:${kind}`, name, kind, node, file };
    this.list.push(unit);
    this.byNode.set(node, unit);
    return unit;
  }

  /** The unit containing `node` (or that `node` is). */
  enclosing(node: ts.Node | undefined): Unit | undefined {
    for (let n = node; n; n = n.parent) {
      const unit = this.byNode.get(n);
      if (unit) return unit;
    }
    return undefined;
  }

  /** Unit for a function the resolver found, if it is part of the project. */
  forFunction(fn: FunctionLike | undefined): Unit | undefined {
    if (!fn || !isProjectFile(this.project, fn.getSourceFile())) return undefined;
    return this.enclosing(fn);
  }
}

export function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__|e2e)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** Name a top-level function from where it is declared, e.g. `taskApi.create`. */
export function unitName(fn: FunctionLike): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)
    || ts.isSetAccessorDeclaration(fn)) && fn.name) {
    const own = propName(fn.name);
    if (ts.isFunctionDeclaration(fn)) return own;
    return `${containerName(fn.parent)}.${own}`;
  }
  if (ts.isFunctionDeclaration(fn)) return 'default';
  if (ts.isConstructorDeclaration(fn)) return `${containerName(fn.parent)}.constructor`;

  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return `${containerName(parent.parent)}.${propName(parent.name)}`;
  if (ts.isBinaryExpression(parent) && parent.right === fn) return parent.left.getText().replace(/\s+/g, '');
  if (ts.isExportAssignment(parent)) return 'default';
  if (ts.isFunctionExpression(fn) && fn.name) return fn.name.text;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText().replace(/\s+/g, '');
    const first = parent.arguments[0];
    const arg = first && ts.isStringLiteralLike(first) ? `'${first.text}'` : '';
    return `${callee}(${arg}) callback`;
  }
  return 'anonymous';
}

function containerName(node: ts.Node): string {
  if (ts.isClassLike(node)) return node.name?.text ?? 'class';
  if (ts.isObjectLiteralExpression(node)) {
    const p = node.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p)) return `${containerName(p.parent)}.${propName(p.name)}`;
    if (ts.isBinaryExpression(p)) return p.left.getText().replace(/\s+/g, '');
    if (ts.isExportAssignment(p)) return 'default';
  }
  return 'object';
}

function propName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
