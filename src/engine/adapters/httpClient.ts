import * as ts from 'typescript';
import type { GraphBuilder } from '../graph';
import { isProjectFile, rangeOf, type Project } from '../project';
import { importSourceOf, isFunctionLike, resolveExpr, resolveFunction, skipOuter, type FunctionLike } from '../resolve';
import {
  constInitializer, evalShorthand, evalString, hasParams, lit, merge, paramIndex, render,
  type EvalContext, type Part,
} from '../strings';
import { isTestFile, type UnitIndex } from '../units';
import { HTTP_METHODS, type RouteInfo } from './express';

/** A request whose URL and method may still depend on the parameters of the function that makes it. */
interface RequestTemplate {
  url: Part[];
  method: Part[];
  notes: string[];
}

interface Summary {
  /** Requests that depend on this function's parameters: it is a wrapper, callers fill them in. */
  open: RequestTemplate[];
  /** Requests fully decided inside this function, with the call that decides them. */
  closed: { template: RequestTemplate; call: ts.CallExpression }[];
}

const MARK = '\u0001';

export function analyzeHttpClient(project: Project, units: UnitIndex, graph: GraphBuilder, routes: RouteInfo[]): void {
  const { checker } = project;
  const memo = new Map<ts.Node, Summary>();
  const inProgress = new Set<ts.Node>();
  const ordered = [...routes].sort((a, b) => a.order - b.order);

  const summarize = (fn: FunctionLike): Summary => {
    const cached = memo.get(fn);
    if (cached) return cached;
    inProgress.add(fn);
    const summary: Summary = { open: [], closed: [] };
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        // A nested function (event handler, local helper) has its own parameters.
        // Requests it fully decides belong to this unit; requests that depend on its
        // parameters are filled in where it is called by name.
        summary.closed.push(...summarize(node).closed);
        return;
      }
      if (ts.isCallExpression(node)) {
        for (const template of templatesAt(node, fn)) {
          if (!hasParams(template.method) && onlyValueParams(template.url)) {
            summary.closed.push({ template: { ...template, url: paramsToWild(template.url) }, call: node });
          } else {
            summary.open.push(template);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    const body = fn.body;
    if (body && ts.isBlock(body)) ts.forEachChild(body, visit);
    else if (body) visit(body);
    inProgress.delete(fn);
    memo.set(fn, summary);
    return summary;
  };

  const templatesAt = (call: ts.CallExpression, fn: FunctionLike): RequestTemplate[] => {
    const ctx: EvalContext = { checker, fn, notes: [] };
    if (isFetch(project, call)) {
      if (!call.arguments.length) return [];
      const url = evalString(ctx, call.arguments[0]);
      const method = call.arguments[1] ? propValue(ctx, call.arguments[1], 'method') : [];
      return [{ url, method, notes: ctx.notes }];
    }
    const viaAxios = axiosTemplate(ctx, call);
    if (viaAxios) return [viaAxios];

    const callee = resolveFunction(checker, call.expression);
    if (!callee || callee === fn || inProgress.has(callee) || !isProjectFile(project, callee.getSourceFile())) return [];
    return summarize(callee).open.map((t) => substitute(ctx, t, call, callee));
  };

  for (const unit of units.list) {
    for (const { template, call } of summarize(unit.node).closed) {
      const from = units.enclosing(call)?.id ?? unit.id;
      const method = methodText(template.method);
      const url = render(template.url, MARK);
      const evidence = rangeOf(project, call);
      const note = template.notes.length ? template.notes.join('; ') : undefined;
      const path = pathOf(url);
      if (path === undefined) {
        graph.addGap({ kind: 'unmatched-request', message: `${method} ${render(template.url, '*')}: URL is not a path the analyzer can match`, evidence });
        continue;
      }
      const label = `${method} ${displayPath(path)}`;
      const match = matchRoute(ordered, method, path);
      if (match) {
        graph.addEdge({ from, to: match.route.id, kind: 'requests', evidence, resolved: match.exact, label, note });
        continue;
      }
      if (isTestFile(evidence.file)) {
        // Tests call missing routes on purpose (404 checks): report, don't draw.
        graph.addGap({ kind: 'unmatched-request', message: `${label} (from a test) has no matching server route`, evidence });
        continue;
      }
      const missingId = `route:${method} ${displayPath(path)}`;
      graph.addNode({
        id: missingId,
        kind: 'route',
        name: missingId.slice('route:'.length),
        ranges: [],
        lang: 'http',
        meta: { method, path: displayPath(path), defined: false },
      });
      graph.addEdge({ from, to: missingId, kind: 'requests', evidence, resolved: false, label, note });
      graph.addGap({ kind: 'unmatched-request', message: `${label} has no matching server route`, evidence });
    }
  }
}

/** Fill a callee's parameter references with the arguments of one call. */
function substitute(ctx: EvalContext, t: RequestTemplate, call: ts.CallExpression, callee: FunctionLike): RequestTemplate {
  const local: EvalContext = { ...ctx, notes: [] };
  const fill = (parts: Part[]): Part[] => merge(parts.flatMap((p): Part[] => {
    if (p.k !== 'param') return [p];
    const param = callee.parameters[p.i];
    if (!param || param.dotDotDotToken) return [{ k: 'wild', text: '...' }];
    const arg = call.arguments[p.i] ?? param.initializer;
    if (!arg) return [];
    return p.prop ? propValue(local, arg, p.prop) : evalString(local, arg);
  }));
  const url = fill(t.url);
  const method = fill(t.method);
  return { url, method, notes: [...t.notes, ...local.notes] };
}

/** Value of property `prop` on an object expression; `[]` when it is certainly absent. */
function propValue(ctx: EvalContext, expr: ts.Expression, prop: string): Part[] {
  const e = skipOuter(expr);
  if (ts.isObjectLiteralExpression(e)) {
    let result: Part[] = [];
    for (const el of e.properties) {
      if (ts.isPropertyAssignment(el) && propertyName(el.name) === prop) result = evalString(ctx, el.initializer);
      else if (ts.isShorthandPropertyAssignment(el) && el.name.text === prop) result = evalShorthand(ctx, el);
      else if (ts.isSpreadAssignment(el)) {
        const spread = propValue(ctx, el.expression, prop);
        if (spread.length) result = spread;
      }
    }
    return result;
  }
  if (ts.isIdentifier(e)) {
    const i = paramIndex(ctx, e);
    if (i !== undefined) return [{ k: 'param', i, prop }];
    const init = constInitializer(ctx.checker, e);
    if (init) return propValue(ctx, init, prop);
  }
  return [{ k: 'wild', text: `${e.getText()}.${prop}` }];
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/** The global `fetch`: named fetch, and not a function the project defines itself. */
function isFetch(project: Project, call: ts.CallExpression): boolean {
  const callee = skipOuter(call.expression);
  const named = (ts.isIdentifier(callee) && callee.text === 'fetch')
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch'
      && /^(window|globalThis|self)$/.test(callee.expression.getText()));
  if (!named) return false;
  const target = resolveFunction(project.checker, call.expression);
  return !target || !isProjectFile(project, target.getSourceFile());
}

/** `axios.get(url)` and `api.post(url)` where `api = axios.create({ baseURL })`. */
function axiosTemplate(ctx: EvalContext, call: ts.CallExpression): RequestTemplate | undefined {
  const callee = skipOuter(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !call.arguments.length) return undefined;
  const verb = callee.name.text;
  if (!HTTP_METHODS.includes(verb) || verb === 'all') return undefined;
  const receiver = skipOuter(callee.expression);
  let base: Part[] | undefined;
  if (ts.isIdentifier(receiver) && importSourceOf(ctx.checker, receiver)?.module === 'axios') {
    base = [];
  } else {
    const target = resolveExpr(ctx.checker, receiver);
    if (target && ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
      && target.expression.name.text === 'create' && ts.isIdentifier(target.expression.expression)
      && importSourceOf(ctx.checker, target.expression.expression)?.module === 'axios') {
      const config = target.arguments[0];
      base = config ? propValue({ ...ctx, fn: undefined }, config, 'baseURL') : [];
    }
  }
  if (!base) return undefined;
  return {
    url: merge([...base, ...evalString(ctx, call.arguments[0])]),
    method: [lit(verb.toUpperCase())],
    notes: ctx.notes,
  };
}

/**
 * A request is decided once its parameters only fill in values (an id
 * between slashes, a query value), not the shape of the path. A parameter
 * that supplies the whole path, as in `request(path)`, makes it a wrapper.
 */
function onlyValueParams(url: Part[]): boolean {
  let inQuery = false;
  for (let i = 0; i < url.length; i++) {
    const p = url[i];
    if (p.k === 'lit') {
      if (p.v.includes('?')) inQuery = true;
      continue;
    }
    if (p.k !== 'param' || inQuery) continue;
    const prev = url[i - 1];
    const next = url[i + 1];
    const afterSlash = prev?.k === 'lit' && /[/=&]$/.test(prev.v);
    const beforeBoundary = !next || (next.k === 'lit' && /^[/?#&]/.test(next.v));
    if (!afterSlash || !beforeBoundary) return false;
  }
  return true;
}

function paramsToWild(parts: Part[]): Part[] {
  return parts.map((p) => (p.k === 'param' ? { k: 'wild', text: `{${p.i}}` } : p));
}

function methodText(parts: Part[]): string {
  if (!parts.length) return 'GET';
  if (parts.some((p) => p.k !== 'lit')) return '*';
  return parts.map((p) => (p.k === 'lit' ? p.v : '')).join('').toUpperCase();
}

/** Path segments of a URL, runtime values as `*`; undefined when not an absolute path. */
function pathOf(url: string): string[] | undefined {
  let rest = url.replace(/^https?:\/\/[^/]*/i, '').replace(/^\/\/[^/]*/, '');
  rest = rest.split(/[?#]/)[0];
  if (!rest.startsWith('/')) return undefined;
  return rest.split('/').filter(Boolean).map((s) => (s.includes(MARK) ? '*' : s));
}

function displayPath(segments: string[]): string {
  return '/' + segments.map((s) => (s === '*' ? ':param' : s)).join('/');
}

/** Emulates Express: the first route, in registration order, whose method and path match. */
function matchRoute(routes: RouteInfo[], method: string, path: string[]): { route: RouteInfo; exact: boolean } | undefined {
  let weak: RouteInfo | undefined;
  for (const route of routes) {
    if (method !== '*' && route.method !== method && route.method !== 'ALL') continue;
    const segs = route.path.split('/').filter(Boolean);
    const result = compare(path, segs);
    if (result === 'exact' && method !== '*') return { route, exact: true };
    if (result && !weak) weak = route;
  }
  return weak ? { route: weak, exact: false } : undefined;
}

function compare(client: string[], server: string[]): 'exact' | 'weak' | undefined {
  let weak = false;
  for (let i = 0; i < Math.max(client.length, server.length); i++) {
    const s = server[i];
    const c = client[i];
    if (s !== undefined && s.startsWith('*')) return weak ? 'weak' : 'exact';
    if (s === undefined || c === undefined) return undefined;
    if (s.startsWith(':')) continue;
    if (c === '*') {
      weak = true;
      continue;
    }
    if (c !== s) return undefined;
  }
  return weak ? 'weak' : 'exact';
}
