import * as vscode from 'vscode';
import type { SourceRange } from '../model/types';
import type { Entry } from './contents';
import { MapPanel } from './mapPanel';
import { ProjectSession } from './session';
import { ContentsTree } from './tree';

const CHOSEN_FOLDER_KEY = 'fetchpad.folder';

export function activate(context: vscode.ExtensionContext): void {
  let session: ProjectSession | undefined;

  /** The folder being mapped: the one picked with "Choose Folder", else the first. */
  const currentRoot = (): string | undefined => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const chosen = context.workspaceState.get<string>(CHOSEN_FOLDER_KEY);
    return folders.find((f) => f.uri.fsPath === chosen)?.uri.fsPath ?? folders[0]?.uri.fsPath;
  };

  const getSession = (): ProjectSession | undefined => {
    const root = currentRoot();
    if (session?.root !== root) {
      session?.dispose();
      session = root ? new ProjectSession(context.extensionPath, root) : undefined;
    }
    return session;
  };

  const tree = new ContentsTree(getSession);
  const view = vscode.window.createTreeView('fetchpad.contents', { treeDataProvider: tree, showCollapseAll: true });
  const describe = () => {
    view.description = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? getSession()?.name : undefined;
  };
  describe();

  const withSession = (run: (s: ProjectSession) => unknown) => () => {
    const s = getSession();
    if (!s) {
      void vscode.window.showInformationMessage('Open a folder first. Fetchpad maps the code in the open folder.');
      return;
    }
    return run(s);
  };

  context.subscriptions.push(
    tree,
    view,
    { dispose: () => session?.dispose() },
    vscode.commands.registerCommand('fetchpad.openMap', withSession((s) => MapPanel.show(context, s))),
    vscode.commands.registerCommand('fetchpad.refresh', withSession((s) => s.refresh())),
    vscode.commands.registerCommand('fetchpad.focus', (id: string) =>
      withSession((s) => MapPanel.show(context, s, id))()),
    vscode.commands.registerCommand('fetchpad.openSource', (target: Entry | SourceRange) =>
      withSession((s) => {
        const range = 'file' in target ? target : target.source;
        return range && s.open(range);
      })()),
    vscode.commands.registerCommand('fetchpad.chooseFolder', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })),
        { placeHolder: 'Which folder should Fetchpad map?' },
      );
      if (!pick) return;
      await context.workspaceState.update(CHOSEN_FOLDER_KEY, pick.root);
      describe();
      tree.refresh();
      if (MapPanel.current) MapPanel.show(context, getSession()!);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      describe();
      tree.refresh();
      // The mapped folder may have been removed: follow the new one, or close.
      const s = getSession();
      if (MapPanel.current && !s) MapPanel.current.close();
      else if (MapPanel.current && s && !MapPanel.current.isFor(s)) MapPanel.show(context, s);
    }),
  );
}

export function deactivate(): void {}
