import * as ts from 'typescript';
import { followSymbol, skipOuter, type FunctionLike } from './resolve';

/**
 * A string worked out statically, as a sequence of parts:
 * - `lit`: text known exactly
 * - `param`: the value of parameter `i` (or its property `prop`) of the
 *   function being summarised; filled in at each call site
 * - `wild`: a runtime value (an id, a user's input) that cannot be known
 */
export type Part =
  | { k: 'lit'; v: string }
  | { k: 'param'; i: number; prop?: string }
  | { k: 'wild'; text: string };

export interface EvalContext {
  checker: ts.TypeChecker;
  /** Function whose parameters stay symbolic. Others' parameters are runtime values. */
  fn?: FunctionLike;
  /** Assumptions made while evaluating, e.g. which env-var fallback was used. */
  notes: string[];
}

const MAX_DEPTH = 25;
const ENV = Symbol('env');

export function evalString(ctx: EvalContext, expr: ts.Expression): Part[] {
  const out = ev(ctx, expr, 0);
  return out === ENV ? [wild(expr)] : out;
}

function ev(ctx: EvalContext, e: ts.Expression, depth: number): Part[] | typeof ENV {
  if (depth > MAX_DEPTH) return [wild(e)];
  e = skipOuter(e);

  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return [lit(e.text)];

  if (ts.isTemplateExpression(e)) {
    const parts: Part[] = [lit(e.head.text)];
    for (const span of e.templateSpans) {
      parts.push(...asParts(ev(ctx, span.expression, depth + 1), span.expression));
      parts.push(lit(span.literal.text));
    }
    return merge(parts);
  }

  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      return merge([
        ...asParts(ev(ctx, e.left, depth + 1), e.left),
        ...asParts(ev(ctx, e.right, depth + 1), e.right),
      ]);
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const left = ev(ctx, e.left, depth + 1);
      if (left === ENV) {
        ctx.notes.push(`assumes ${e.left.getText()} is unset, so ${e.right.getText()} is used`);
        return ev(ctx, e.right, depth + 1);
      }
      if (isLiteral(left) && (op === ts.SyntaxKind.QuestionQuestionToken || literalText(left) !== '')) return left;
      return [wild(e)];
    }
  }

  if (isEnvAccess(e)) return ENV;

  if (ts.isIdentifier(e)) {
    const param = paramIndex(ctx, e);
    if (param !== undefined) return [{ k: 'param', i: param }];
    const init = constInitializer(ctx.checker, e);
    return init ? ev(ctx, init, depth + 1) : [wild(e)];
  }

  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression)) {
      const param = paramIndex(ctx, e.expression);
      if (param !== undefined) return [{ k: 'param', i: param, prop: e.name.text }];
    }
    const init = constInitializer(ctx.checker, e);
    return init ? ev(ctx, init, depth + 1) : [wild(e)];
  }

  return [wild(e)];
}

/**
 * Value of `{ name }` shorthand. The name's own symbol is the property, so the
 * variable it reads has to be looked up separately.
 */
export function evalShorthand(ctx: EvalContext, el: ts.ShorthandPropertyAssignment): Part[] {
  const sym = ctx.checker.getShorthandAssignmentValueSymbol(el);
  const decl = sym?.valueDeclaration;
  if (decl && ts.isParameter(decl) && ctx.fn && decl.parent === ctx.fn && !decl.dotDotDotToken) {
    return [{ k: 'param', i: ctx.fn.parameters.indexOf(decl) }];
  }
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isConst(decl)) {
    return evalString(ctx, decl.initializer);
  }
  return [wild(el)];
}

/** Index of `ident` among the parameters of `ctx.fn`, if it names one. */
export function paramIndex(ctx: EvalContext, ident: ts.Identifier): number | undefined {
  if (!ctx.fn) return undefined;
  const sym = ctx.checker.getSymbolAtLocation(ident);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl) || decl.parent !== ctx.fn || !ts.isIdentifier(decl.name)) return undefined;
  if (decl.dotDotDotToken) return undefined;
  return ctx.fn.parameters.indexOf(decl);
}

/**
 * The initializer of a `const` (or a property of a `const` object literal)
 * that `expr` refers to, following imports. `let`/`var` are not followed:
 * they can be reassigned, so their value is not provable.
 */
export function constInitializer(checker: ts.TypeChecker, expr: ts.Expression): ts.Expression | undefined {
  const sym = ts.isPropertyAccessExpression(expr) ? checker.getSymbolAtLocation(expr.name) : checker.getSymbolAtLocation(expr);
  if (!sym) return undefined;
  let s = sym;
  if (s.flags & ts.SymbolFlags.Alias) {
    try {
      s = checker.getAliasedSymbol(s);
    } catch {
      return undefined;
    }
  }
  const decl = s.valueDeclaration;
  if (!decl) return undefined;
  if (ts.isVariableDeclaration(decl) && decl.initializer && isConst(decl)) return decl.initializer;
  if (ts.isPropertyAssignment(decl) && ts.isObjectLiteralExpression(decl.parent)) {
    const holder = decl.parent.parent;
    if (ts.isVariableDeclaration(holder) && isConst(holder)) return decl.initializer;
  }
  if (ts.isShorthandPropertyAssignment(decl)) {
    const value = checker.getShorthandAssignmentValueSymbol(decl);
    const target = value && followSymbol(checker, value);
    return target && ts.isExpression(target) ? target : undefined;
  }
  return undefined;
}

function isConst(decl: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isEnvAccess(e: ts.Expression): boolean {
  const text = e.getText().replace(/\s+/g, '');
  return /^import\.meta\.env(\.|\[)/.test(text) || /^process\.env(\.|\[)/.test(text);
}

function asParts(r: Part[] | typeof ENV, e: ts.Expression): Part[] {
  return r === ENV ? [wild(e)] : r;
}

export function lit(v: string): Part {
  return { k: 'lit', v };
}

function wild(e: ts.Node): Part {
  return { k: 'wild', text: e.getText() };
}

/** Join neighbouring literal parts. */
export function merge(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (p.k === 'lit' && p.v === '') continue;
    if (p.k === 'lit' && prev?.k === 'lit') out[out.length - 1] = lit(prev.v + p.v);
    else out.push(p);
  }
  return out;
}

export function isLiteral(parts: Part[]): boolean {
  return parts.every((p) => p.k === 'lit');
}

export function literalText(parts: Part[]): string {
  return parts.map((p) => (p.k === 'lit' ? p.v : '')).join('');
}

export function hasParams(parts: Part[]): boolean {
  return parts.some((p) => p.k === 'param');
}

/** Render parts as text, with runtime values shown as `marker`. */
export function render(parts: Part[], marker: string): string {
  return parts.map((p) => (p.k === 'lit' ? p.v : p.k === 'wild' ? marker : `{${p.i}${p.prop ? '.' + p.prop : ''}}`)).join('');
}
