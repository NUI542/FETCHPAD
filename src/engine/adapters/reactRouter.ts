import * as ts from 'typescript';
import type { GraphBuilder } from '../graph';
import { isProjectFile, rangeOf, type Project } from '../project';
import { importSourceOf, resolveFunction } from '../resolve';
import type { UnitIndex } from '../units';
import { joinPath } from './express';

type RouteElement = ts.JsxElement | ts.JsxSelfClosingElement;

/** Pages from React Router's `<Route path element>` trees, nested paths joined. */
export function analyzeReactRouter(project: Project, units: UnitIndex, graph: GraphBuilder): void {
  const { checker } = project;

  const opening = (el: RouteElement) => (ts.isJsxElement(el) ? el.openingElement : el);
  const isRoute = (node: ts.Node): node is RouteElement => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
    const tag = opening(node).tagName;
    if (!ts.isIdentifier(tag) || tag.text !== 'Route') return false;
    const src = importSourceOf(checker, tag);
    return !!src && /^react-router(-dom)?$/.test(src.module);
  };

  const attr = (el: RouteElement, name: string): ts.JsxAttribute | undefined =>
    opening(el).attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
    );

  const process = (el: RouteElement, base: string, layoutId: string | undefined): void => {
    const pathAttr = attr(el, 'path')?.initializer;
    const path = pathAttr && ts.isStringLiteral(pathAttr) ? pathAttr.text : undefined;
    const index = !!attr(el, 'index');
    const full = index || path === undefined ? base || '/' : path.startsWith('/') ? joinPath('', path) : joinPath(base, path);
    const children = ts.isJsxElement(el) ? el.children.filter(isRoute) : [];
    const id = children.length ? `page:${full}:layout` : `page:${full}`;

    const element = attr(el, 'element')?.initializer;
    const components: { id: string; name: string; node: ts.Node }[] = [];
    if (element && ts.isJsxExpression(element) && element.expression) {
      const collect = (n: ts.Node): void => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          const tag = n.tagName;
          if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
            const unit = units.forFunction(resolveFunction(checker, tag));
            if (unit) components.push({ id: unit.id, name: unit.name, node: n });
          }
        }
        ts.forEachChild(n, collect);
      };
      collect(element.expression);
    }

    if (path !== undefined || index || components.length) {
      graph.addNode({
        id,
        kind: 'page',
        name: children.length ? `${full} (layout)` : full,
        ranges: [rangeOf(project, opening(el))],
        lang: 'jsx',
        meta: { path: full, layout: children.length > 0, layoutId, components: components.map((c) => c.name) },
      });
      components.forEach((c, i) => {
        graph.addEdge({
          from: id, to: c.id, kind: 'renders', evidence: rangeOf(project, c.node), resolved: true,
          label: components.length > 1 && i < components.length - 1 ? 'wraps' : undefined,
        });
      });
    }
    for (const child of children) process(child, full, children.length ? id : layoutId);
  };

  for (const sf of project.program.getSourceFiles()) {
    if (!isProjectFile(project, sf)) continue;
    const visit = (node: ts.Node): void => {
      if (isRoute(node)) {
        process(node, '', undefined);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}
