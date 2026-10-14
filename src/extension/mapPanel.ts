import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../shared/protocol';
import { Highlighter } from './highlight';
import type { ProjectSession } from './session';

/** The map, in an editor tab beside the code. One per window. */
export class MapPanel {
  static current: MapPanel | undefined;

  /** Show the map for `session`, optionally focused on node `focus`. */
  static show(context: vscode.ExtensionContext, session: ProjectSession, focus?: string): void {
    const current = MapPanel.current;
    if (current && current.session === session) {
      current.panel.reveal(undefined, false);
      if (focus) current.focus(focus);
      return;
    }
    current?.panel.dispose();
    MapPanel.current = new MapPanel(context, session, focus);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly highlighter = new Highlighter();
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingFocus?: string;

  private constructor(context: vscode.ExtensionContext, private readonly session: ProjectSession, focus?: string) {
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.pendingFocus = focus;
    this.panel = vscode.window.createWebviewPanel(
      'fetchpad.map',
      `Map · ${session.name}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'fetchpad.svg');
    this.panel.webview.html = this.html(dist);
    this.disposables.push(
      session.onDidChange(() => this.sendState()),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.highlighter.themeChanged();
        this.post({ type: 'themeChanged' });
      }),
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
    );
    session.ensureStarted();
  }

  isFor(session: ProjectSession): boolean {
    return this.session === session;
  }

  close(): void {
    this.panel.dispose();
  }

  private focus(id: string): void {
    if (this.ready) this.post({ type: 'focus', id });
    else this.pendingFocus = id;
  }

  private sendState(): void {
    if (!this.ready) return;
    const { graph, stats, status } = this.session;
    if (graph && stats) this.post({ type: 'graph', graph, stats });
    this.post({ type: 'status', state: status.state, message: status.message });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.pendingFocus) this.post({ type: 'focus', id: this.pendingFocus });
        this.pendingFocus = undefined;
        this.sendState();
        break;
      case 'refresh':
        this.session.refresh();
        break;
      case 'open': {
        // Open code in the other column, so the map stays visible.
        const column = this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
        await this.session.open(msg.range, column);
        break;
      }
      case 'code':
        try {
          const uri = this.session.fileUri(msg.file);
          // Open documents include unsaved edits.
          const doc = await vscode.workspace.openTextDocument(uri);
          const code = await this.highlighter.highlight(msg.file, doc.getText(), uri.fsPath);
          this.post({ type: 'code', requestId: msg.requestId, code });
        } catch (err) {
          this.post({ type: 'code', requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) });
        }
        break;
    }
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(dist: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Code Map</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    for (const d of this.disposables) d.dispose();
    if (MapPanel.current === this) MapPanel.current = undefined;
  }
}
