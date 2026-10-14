import * as ts from 'typescript';
import type { GraphBuilder } from '../graph';
import { rangeOf, type Project } from '../project';
import { importSourceOf, isFunctionLike, resolveFunction, skipOuter } from '../resolve';
import type { UnitIndex } from '../units';

/**
 * Plain code structure: which functions each function calls, which
 * components it renders, and which functions it passes as callbacks.
 */
export function analyzeCalls(project: Project, units: UnitIndex, graph: GraphBuilder): void {
  const { checker } = project;
  for (const unit of units.list) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target = units.forFunction(resolveFunction(checker, node.expression));
        if (target) {
          graph.addEdge({ from: unit.id, to: target.id, kind: 'calls', evidence: rangeOf(project, node), resolved: true });
        }
        for (const arg of node.arguments) {
          const a = skipOuter(arg);
          if (!ts.isIdentifier(a) && !ts.isPropertyAccessExpression(a)) continue;
          const passed = units.forFunction(resolveFunction(checker, a));
          if (passed) {
            graph.addEdge({ from: unit.id, to: passed.id, kind: 'calls', label: 'callback', evidence: rangeOf(project, a), resolved: true });
          }
        }
      }
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && !inRouteElement(checker, node)) {
        const tag = node.tagName;
        if ((ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) || ts.isPropertyAccessExpression(tag)) {
          const target = units.forFunction(resolveFunction(checker, tag));
          if (target) {
            graph.addEdge({ from: unit.id, to: target.id, kind: 'renders', evidence: rangeOf(project, node), resolved: true });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit.node, visit);
  }
}

/**
 * JSX passed to `<Route element={...}>` is rendered by the router for that
 * page, not by the component that declares the routes; pages model it.
 */
function inRouteElement(checker: ts.TypeChecker, node: ts.Node): boolean {
  for (let n = node.parent; n && !isFunctionLike(n); n = n.parent) {
    if (!ts.isJsxAttribute(n) || !ts.isIdentifier(n.name) || n.name.text !== 'element') continue;
    const owner = n.parent.parent;
    if ((ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) && ts.isIdentifier(owner.tagName)
      && owner.tagName.text === 'Route' && /^react-router(-dom)?$/.test(importSourceOf(checker, owner.tagName)?.module ?? '')) {
      return true;
    }
  }
  return false;
}
