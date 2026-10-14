import * as vscode from 'vscode';
import { contentsOf, type Entry } from './contents';
import type { ProjectSession } from './session';

/** Rows only the live tree has: the open-map button and the analysis status. */
const OPEN_MAP: Entry = { id: 'action:open', label: 'Open Code Map', icon: 'type-hierarchy' };

/** The Fetchpad sidebar: open the map, or jump straight to an endpoint, page or table. */
export class ContentsTree implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Entry | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private sessionListener?: vscode.Disposable;
  private session?: ProjectSession;
  private cache?: { graph: unknown; entries: Entry[] };

  constructor(private readonly getSession: () => ProjectSession | undefined) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(entry?: Entry): Entry[] {
    if (entry) return entry.children ?? [];
    const session = this.getSession();
    if (!session) return [];
    this.watch(session);
    session.ensureStarted();

    const rows: Entry[] = [OPEN_MAP];
    const { graph, status } = session;
    if (status.state === 'error') {
      rows.push({
        id: 'status:error', label: 'Analysis failed', description: status.message?.split('\n')[0],
        tooltip: status.message, icon: 'error', iconColor: 'problemsErrorIcon.foreground',
      });
    } else if (!graph) {
      rows.push({ id: 'status:analyzing', label: 'Analyzing…', icon: 'loading~spin' });
    }
    if (!graph) return rows;

    if (this.cache?.graph !== graph) this.cache = { graph, entries: contentsOf(graph) };
    if (!this.cache.entries.length) {
      rows.push({
        id: 'status:empty',
        label: 'No endpoints, pages or tables found',
        tooltip: 'Fetchpad currently understands Express routes, React Router pages, fetch and axios calls, and SQL in JavaScript or TypeScript projects.',
        icon: 'info',
      });
    }
    return [...rows, ...this.cache.entries];
  }

  getTreeItem(entry: Entry): vscode.TreeItem {
    const state = entry.children
      ? entry.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(entry.label, state);
    item.id = entry.id;
    item.description = entry.description;
    item.tooltip = entry.tooltip;
    item.iconPath = new vscode.ThemeIcon(entry.icon, entry.iconColor ? new vscode.ThemeColor(entry.iconColor) : undefined);
    if (entry === OPEN_MAP) {
      item.command = { command: 'fetchpad.openMap', title: 'Open Code Map' };
    } else if (entry.opensSource && entry.source) {
      item.command = { command: 'fetchpad.openSource', title: 'Open source', arguments: [entry] };
    } else if (entry.focus) {
      item.command = { command: 'fetchpad.focus', title: 'Show on the map', arguments: [entry.focus] };
    }
    // Enables the inline "Open source" button on rows with code behind them.
    if (entry.source && !entry.opensSource) item.contextValue = 'hasSource';
    return item;
  }

  private watch(session: ProjectSession): void {
    if (this.session === session) return;
    this.sessionListener?.dispose();
    this.session = session;
    this.cache = undefined;
    this.sessionListener = session.onDidChange(() => this.refresh());
  }

  dispose(): void {
    this.sessionListener?.dispose();
    this.changed.dispose();
  }
}
