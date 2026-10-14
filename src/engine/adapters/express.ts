import * as ts from 'typescript';
import type { GraphBuilder } from '../graph';
import { isProjectFile, rangeOf, type Project } from '../project';
import { importSourceOf, isFunctionLike, resolveExpr, resolveFunction, shortText, skipOuter } from '../resolve';
import type { UnitIndex } from '../units';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

export interface MiddlewareRef {
  label: string;
  /** Unit ID of the middleware function (or of the factory that makes it). */
  fn?: string;
}

export interface RouteInfo {
  id: string;
  method: string;
  path: string;
  /** Registration order across the whole app; Express tries routes in this order. */
  order: number;
}

interface RouterObj {
  kind: 'app' | 'router';
  name: string;
  init: ts.CallExpression;
  symbol: ts.Symbol;
  calls: RouterCall[];
}

interface RouterCall {
  method: string;
  /** Path argument for `.route(path).get(...)` chains, already taken off `args`. */
  routePath?: ts.Expression;
  args: readonly ts.Expression[];
  node: ts.CallExpression;
}

interface ScopedMiddleware {
  scope: string;
  ref: MiddlewareRef;
}

export function analyzeExpress(project: Project, units: UnitIndex, graph: GraphBuilder): RouteInfo[] {
  const { checker } = project;
  const routers = findRouters(project);
  if (!routers.length) return [];
  const byInit = new Map<ts.Node, RouterObj>(routers.map((r) => [r.init, r]));
  collectCalls(project, routers);

  const routes: RouteInfo[] = [];
  const mounted = new Set<RouterObj>();
  let order = 0;

  const middlewareRef = (arg: ts.Expression): MiddlewareRef => {
    const e = skipOuter(arg);
    if (isFunctionLike(e)) return { label: 'inline middleware', fn: units.forFunction(e)?.id };
    if (ts.isCallExpression(e)) {
      // A factory such as requireRole('admin') or express.json()
      const factory = units.forFunction(resolveFunction(checker, e.expression));
      return { label: shortText(e), fn: factory?.id };
    }
    return { label: shortText(e), fn: units.forFunction(resolveFunction(checker, e))?.id };
  };

  const routerOf = (arg: ts.Expression): RouterObj | undefined => {
    const target = resolveExpr(checker, arg);
    return target ? byInit.get(target) : undefined;
  };

  const walk = (router: RouterObj, prefix: string, inherited: ScopedMiddleware[], trail: Set<RouterObj>): void => {
    mounted.add(router);
    const stack = [...inherited];
    for (const call of router.calls) {
      const args = [...call.args];
      if (call.method === 'use') {
        let scope = prefix;
        if (args.length && ts.isStringLiteralLike(skipOuter(args[0]))) {
          scope = joinPath(prefix, (skipOuter(args.shift()!) as ts.StringLiteralLike).text);
        }
        const local: ScopedMiddleware[] = [];
        for (const arg of flatten(args)) {
          const child = routerOf(arg);
          if (child && !trail.has(child)) {
            walk(child, scope, [...stack, ...local], new Set([...trail, child]));
          } else if (!child) {
            local.push({ scope, ref: middlewareRef(arg) });
          }
        }
        stack.push(...local);
        continue;
      }

      const pathArg = call.routePath ?? args.shift();
      const pathNode = pathArg && skipOuter(pathArg);
      if (!pathNode || !ts.isStringLiteralLike(pathNode)) continue;
      const fullPath = joinPath(prefix, pathNode.text);
      const handlers = flatten(args);
      if (!handlers.length) continue;

      const method = call.method.toUpperCase();
      const id = `route:${method} ${fullPath}`;
      const handlerArg = handlers[handlers.length - 1];
      const handlerFn = resolveFunction(checker, handlerArg);
      const handler = units.forFunction(handlerFn);
      const middleware = [
        ...stack.filter((m) => appliesTo(m.scope, fullPath)).map((m) => m.ref),
        ...handlers.slice(0, -1).map(middlewareRef),
      ];

      if (graph.getNode(id)) {
        graph.addGap({
          kind: 'duplicate-route',
          message: `${method} ${fullPath} is registered more than once; Express only runs the first one`,
          evidence: rangeOf(project, call.node),
        });
        continue;
      }

      graph.addNode({
        id,
        kind: 'route',
        name: `${method} ${fullPath}`,
        ranges: [rangeOf(project, call.node)],
        lang: 'http',
        meta: { method, path: fullPath, order, middleware, handler: handler?.id, framework: 'express' },
      });
      routes.push({ id, method, path: fullPath, order });
      order++;

      if (handler) {
        graph.addEdge({ from: id, to: handler.id, kind: 'handles', evidence: rangeOf(project, handlerArg), resolved: true });
      }
      middleware.forEach((m, i) => {
        if (m.fn) {
          graph.addEdge({
            from: id, to: m.fn, kind: 'middleware', label: `${i + 1}. ${m.label}`,
            evidence: rangeOf(project, call.node), resolved: true,
          });
        }
      });
    }
  };

  for (const app of routers.filter((r) => r.kind === 'app')) walk(app, '', [], new Set([app]));
  for (const router of routers) {
    if (!mounted.has(router)) {
      graph.addGap({
        kind: 'unmounted-router',
        message: `Router "${router.name}" is never mounted with app.use(), so its routes are unreachable`,
        evidence: rangeOf(project, router.init),
      });
    }
  }
  return routes;
}

/** `const app = express()` and `const router = express.Router()` / `Router()`. */
function findRouters(project: Project): RouterObj[] {
  const { checker } = project;
  const out: RouterObj[] = [];
  for (const sf of project.program.getSourceFiles()) {
    if (!isProjectFile(project, sf)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = skipOuter(node.initializer);
        if (ts.isCallExpression(init)) {
          const kind = expressFactoryKind(checker, init.expression);
          const symbol = checker.getSymbolAtLocation(node.name);
          if (kind && symbol) out.push({ kind, name: node.name.text, init, symbol, calls: [] });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function expressFactoryKind(checker: ts.TypeChecker, callee: ts.Expression): 'app' | 'router' | undefined {
  callee = skipOuter(callee);
  if (ts.isIdentifier(callee)) {
    const src = importSourceOf(checker, callee);
    if (src?.module !== 'express') return undefined;
    if (src.imported === 'default' || src.imported === '*') return 'app';
    if (src.imported === 'Router') return 'router';
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Router' && ts.isIdentifier(callee.expression)) {
    const src = importSourceOf(checker, callee.expression);
    if (src?.module === 'express') return 'router';
  }
  return undefined;
}

/** Every `x.use/get/post/...(...)` and `x.route(p).get(...)` on each router, in source order. */
function collectCalls(project: Project, routers: RouterObj[]): void {
  const { checker } = project;
  const bySymbol = new Map<ts.Symbol, RouterObj>(routers.map((r) => [r.symbol, r]));
  const receiverOf = (e: ts.Expression): RouterObj | undefined => {
    e = skipOuter(e);
    if (!ts.isIdentifier(e)) return undefined;
    const sym = checker.getSymbolAtLocation(e);
    return sym ? bySymbol.get(sym) : undefined;
  };

  for (const sf of project.program.getSourceFiles()) {
    if (!isProjectFile(project, sf)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const router = receiverOf(node.expression.expression);
        if (router && (method === 'use' || HTTP_METHODS.includes(method))) {
          router.calls.push({ method, args: node.arguments, node });
        } else if (router && method === 'route' && node.arguments.length) {
          // router.route('/x').get(a).post(b)
          let chain: ts.Node = node;
          while (ts.isPropertyAccessExpression(chain.parent) && ts.isCallExpression(chain.parent.parent)
            && chain.parent.parent.expression === chain.parent) {
            const verb = chain.parent.name.text;
            const call = chain.parent.parent;
            if (HTTP_METHODS.includes(verb)) {
              router.calls.push({ method: verb, routePath: node.arguments[0], args: call.arguments, node: call });
            }
            chain = call;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const r of routers) {
    r.calls.sort((a, b) => {
      const fa = a.node.getSourceFile().fileName;
      const fb = b.node.getSourceFile().fileName;
      return fa === fb ? a.node.getStart() - b.node.getStart() : fa < fb ? -1 : 1;
    });
  }
}

function flatten(args: readonly ts.Expression[]): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (const a of args) {
    const e = skipOuter(a);
    if (ts.isArrayLiteralExpression(e)) out.push(...flatten(e.elements));
    else out.push(a);
  }
  return out;
}

export function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

function appliesTo(scope: string, path: string): boolean {
  return scope === '' || scope === '/' || path === scope || path.startsWith(scope + '/');
}
