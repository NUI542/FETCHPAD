import * as path from 'path';
import * as vscode from 'vscode';
import type { MapGraph, SourceRange } from '../model/types';
import type { AnalysisStats } from '../shared/protocol';
import { AnalysisService } from './analysis';

const WATCHED = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,sql}';
const IGNORED = /[\\/](node_modules|dist|build|out|\.git|\.next|coverage|\.fetchpad)[\\/]/;
const REFRESH_DELAY_MS = 300;

export type SessionStatus = { state: 'idle' | 'analyzing' | 'error'; message?: string };

/**
 * One analysed project folder. The sidebar and the map both read from it, so
 * the code is analysed once however many views show it. Nothing runs until
 * a view asks for it.
 */
export class ProjectSession implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the graph or the status changes. */
  readonly onDidChange = this.changed.event;

  graph?: MapGraph;
  stats?: AnalysisStats;
  status: SessionStatus = { state: 'idle' };

  private analysis?: AnalysisService;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly extensionPath: string, readonly root: string) {}

  get name(): string {
    return path.basename(this.root);
  }

  /** Start analysing and watching, the first time anything needs the graph. */
  ensureStarted(): void {
    if (this.analysis) return;
    this.analysis = new AnalysisService(this.extensionPath, this.root);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, WATCHED));
    // Agents write files to disk without saving through the editor, so watch the disk.
    const onFile = (uri: vscode.Uri) => {
      if (!IGNORED.test(uri.fsPath)) this.scheduleRefresh();
    };
    this.disposables.push(watcher, watcher.onDidChange(onFile), watcher.onDidCreate(onFile), watcher.onDidDelete(onFile));
    this.refresh();
  }

  refresh(): void {
    if (!this.analysis) return this.ensureStarted();
    this.status = { state: 'analyzing' };
    this.changed.fire();
    this.analysis.analyze().then(
      ({ graph, ms }) => {
        this.graph = graph;
        this.stats = { ms, at: Date.now() };
        this.status = { state: 'idle' };
        this.changed.fire();
      },
      (err: Error) => {
        this.status = { state: 'error', message: err.message };
        this.changed.fire();
      },
    );
  }

  /** Resolve a project-relative path, refusing anything outside the project. */
  fileUri(file: string): vscode.Uri {
    const abs = path.resolve(this.root, file);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`Outside the project: ${file}`);
    return vscode.Uri.file(abs);
  }

  /** Open a file in the editor with `range` selected. */
  async open(range: SourceRange, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.fileUri(range.file));
    const selection = new vscode.Range(range.startLine - 1, range.startCol - 1, range.endLine - 1, range.endCol - 1);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn, selection });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), REFRESH_DELAY_MS);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.analysis?.dispose();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}
