import * as ts from 'typescript';

export type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const MAX_HOPS = 20;

export function isFunctionLike(node: ts.Node): node is FunctionLike {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

/** Strip parentheses and type-only wrappers that do not change the value. */
export function skipOuter(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
    || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

export function symbolAt(checker: ts.TypeChecker, expr: ts.Expression): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expr)) return checker.getSymbolAtLocation(expr.name);
  if (ts.isElementAccessExpression(expr)) {
    return ts.isStringLiteralLike(expr.argumentExpression)
      ? checker.getSymbolAtLocation(expr.argumentExpression)
      : undefined;
  }
  return checker.getSymbolAtLocation(expr);
}

/**
 * Follow an identifier or property access through imports, `require`,
 * `module.exports` assignments and object properties to the expression or
 * declaration that finally produces its value. Returns `undefined` when the
 * chain leaves the program (library code) or cannot be followed statically.
 */
export function resolveExpr(checker: ts.TypeChecker, expr: ts.Expression, hops = 0): ts.Node | undefined {
  if (hops > MAX_HOPS) return undefined;
  expr = skipOuter(expr);
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const sym = symbolAt(checker, expr);
    return sym ? followSymbol(checker, sym, hops + 1) : undefined;
  }
  return expr;
}

export function followSymbol(checker: ts.TypeChecker, sym: ts.Symbol, hops = 0): ts.Node | undefined {
  if (hops > MAX_HOPS) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      const target = checker.getAliasedSymbol(sym);
      if (target && target !== sym) sym = target;
    } catch {
      return undefined;
    }
  }
  const decls = sym.valueDeclaration ? [sym.valueDeclaration] : (sym.declarations ?? []);
  for (const decl of decls) {
    const out = followDeclaration(checker, decl, hops + 1);
    if (out) return out;
  }
  return undefined;
}

function followDeclaration(checker: ts.TypeChecker, decl: ts.Node, hops: number): ts.Node | undefined {
  if (isFunctionLike(decl) || ts.isClassDeclaration(decl) || ts.isParameter(decl) || ts.isSourceFile(decl)) {
    return decl;
  }
  if (ts.isVariableDeclaration(decl)) {
    if (!decl.initializer) return decl;
    return resolveExpr(checker, decl.initializer, hops) ?? decl.initializer;
  }
  if (ts.isPropertyAssignment(decl)) {
    return resolveExpr(checker, decl.initializer, hops) ?? decl.initializer;
  }
  if (ts.isShorthandPropertyAssignment(decl)) {
    const value = checker.getShorthandAssignmentValueSymbol(decl);
    return value ? followSymbol(checker, value, hops) : undefined;
  }
  if (ts.isBinaryExpression(decl)) {
    // module.exports = x / exports.x = x
    return resolveExpr(checker, decl.right, hops) ?? decl.right;
  }
  if ((ts.isPropertyAccessExpression(decl) || ts.isElementAccessExpression(decl))
    && ts.isBinaryExpression(decl.parent) && decl.parent.left === decl) {
    return resolveExpr(checker, decl.parent.right, hops) ?? decl.parent.right;
  }
  if (ts.isExportAssignment(decl)) {
    return resolveExpr(checker, decl.expression, hops) ?? decl.expression;
  }
  if (ts.isBindingElement(decl)) {
    return followBindingElement(checker, decl, hops);
  }
  return decl;
}

/** `const { a } = require('./m')` or `const { a } = obj`: look `a` up on the initializer. */
function followBindingElement(checker: ts.TypeChecker, decl: ts.BindingElement, hops: number): ts.Node | undefined {
  const pattern = decl.parent;
  if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(pattern.parent)) return undefined;
  const init = pattern.parent.initializer;
  if (!init) return undefined;
  const key = decl.propertyName ?? decl.name;
  if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return undefined;
  const prop = checker.getTypeAtLocation(init).getProperty(key.text);
  return prop ? followSymbol(checker, prop, hops) : undefined;
}

/** Resolve a callee or reference to the function that defines it. */
export function resolveFunction(checker: ts.TypeChecker, expr: ts.Expression): FunctionLike | undefined {
  const out = resolveExpr(checker, expr);
  return out && isFunctionLike(out) ? out : undefined;
}

/** True when `node` is `require('<spec>')`. */
export function isRequireOf(node: ts.Node | undefined, spec?: string): node is ts.CallExpression {
  return !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === 'require' && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
    && (spec === undefined || node.arguments[0].text === spec);
}

/** The module specifier a local binding was imported or required from, if any. */
export function importSourceOf(checker: ts.TypeChecker, ident: ts.Identifier): { module: string; imported: string } | undefined {
  const sym = checker.getSymbolAtLocation(ident);
  for (const d of sym?.declarations ?? []) {
    if (ts.isVariableDeclaration(d) && isRequireOf(d.initializer)) {
      return { module: (d.initializer.arguments[0] as ts.StringLiteral).text, imported: 'default' };
    }
    if (ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent) && ts.isVariableDeclaration(d.parent.parent)
      && isRequireOf(d.parent.parent.initializer)) {
      const key = d.propertyName ?? d.name;
      return {
        module: (d.parent.parent.initializer.arguments[0] as ts.StringLiteral).text,
        imported: ts.isIdentifier(key) ? key.text : key.getText(),
      };
    }
    if (ts.isImportClause(d)) {
      return { module: (d.parent.moduleSpecifier as ts.StringLiteral).text, imported: 'default' };
    }
    if (ts.isNamespaceImport(d)) {
      return { module: (d.parent.parent.moduleSpecifier as ts.StringLiteral).text, imported: '*' };
    }
    if (ts.isImportSpecifier(d)) {
      return {
        module: (d.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text,
        imported: (d.propertyName ?? d.name).text,
      };
    }
  }
  return undefined;
}

/** Short single-line source text for labels. */
export function shortText(node: ts.Node, max = 60): string {
  const text = node.getText().replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
