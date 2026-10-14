import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { SourceRange } from '../model/types';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.venv', 'venv', '__pycache__', '.vscode', '.idea', '.turbo', '.cache', '.fetchpad',
]);
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

export interface Project {
  /** Absolute path of the workspace root. */
  root: string;
  codeFiles: string[];
  sqlFiles: string[];
  program: ts.Program;
  checker: ts.TypeChecker;
}

/**
 * Parsed files kept between runs. Handing TypeScript the same SourceFile
 * object for unchanged text lets it skip re-parsing and re-binding that file.
 */
export class SourceFileCache {
  private files = new Map<string, ts.SourceFile>();

  get(fileName: string, text: string, version: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.SourceFile {
    const hit = this.files.get(fileName);
    if (hit && hit.text === text) return hit;
    const sf = ts.createSourceFile(fileName, text, version, true);
    this.files.set(fileName, sf);
    return sf;
  }

  retain(fileNames: Iterable<string>): void {
    const keep = new Set(fileNames);
    for (const name of this.files.keys()) if (!keep.has(name)) this.files.delete(name);
  }
}

export interface LoadOptions {
  cache?: SourceFileCache;
  oldProgram?: ts.Program;
}

export function loadProject(root: string, { cache, oldProgram }: LoadOptions = {}): Project {
  root = path.resolve(root);
  const codeFiles: string[] = [];
  const sqlFiles: string[] = [];
  walk(root, (file) => {
    const ext = path.extname(file).toLowerCase();
    if (file.endsWith('.d.ts')) return;
    if (CODE_EXT.has(ext)) codeFiles.push(file);
    else if (ext === '.sql') sqlFiles.push(file);
  });
  codeFiles.sort();
  sqlFiles.sort();

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    skipLibCheck: true,
    // Only the user's own files: library and runtime typings are not part of
    // the map, and loading them costs seconds.
    noLib: true,
    types: [],
    maxNodeModuleJsDepth: 0,
  };
  const host = ts.createCompilerHost(options, true);
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, opts) =>
    literals.map((literal) => {
      // Package imports ('react', 'express') are recognised by name; searching
      // node_modules for them is the slowest part of loading a project.
      if (!/^(\.{1,2}(\/|$)|\/)/.test(literal.text)) return { resolvedModule: undefined };
      const result = ts.resolveModuleName(literal.text, containingFile, opts, host, undefined, redirected);
      const file = result.resolvedModule?.resolvedFileName;
      const inProject = !!file && path.resolve(file).startsWith(root) && !/[\\/]node_modules[\\/]/.test(file);
      return inProject ? result : { resolvedModule: undefined };
    });
  if (cache) {
    host.getSourceFile = (fileName, version) => {
      const text = host.readFile(fileName);
      return text === undefined ? undefined : cache.get(fileName, text, version);
    };
  }
  const program = ts.createProgram({ rootNames: codeFiles, options, host, oldProgram });
  cache?.retain(program.getSourceFiles().map((sf) => sf.fileName));
  return { root, codeFiles, sqlFiles, program, checker: program.getTypeChecker() };
}

function walk(dir: string, visit: (file: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

/** Workspace-relative path with forward slashes. */
export function relPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function isProjectFile(project: Project, sf: ts.SourceFile): boolean {
  return !sf.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(sf.fileName)
    && path.resolve(sf.fileName).startsWith(project.root);
}

export function rangeOf(project: Project, node: ts.Node): SourceRange {
  const sf = node.getSourceFile();
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: relPath(project.root, sf.fileName),
    startLine: start.line + 1,
    startCol: start.character + 1,
    endLine: end.line + 1,
    endCol: end.character + 1,
  };
}

export function langOf(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'ts';
  return 'js';
}
