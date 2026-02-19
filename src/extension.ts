import * as vscode from 'vscode';
import { ProjectIndex } from './analysis/projectIndex';
import { explainFile } from './commands/explainFile';
import { explainSelection } from './commands/explainSelection';
import { ProjectMapPanel } from './ui/projectMap';

const SOURCE_FILE = /\.(m|c)?[jt]sx?$/;

export function activate(context: vscode.ExtensionContext): void {
  const index = new ProjectIndex();
  let refreshTimer: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('codesense.explainSelection', explainSelection),
    vscode.commands.registerCommand('codesense.explainFile', (uri?: vscode.Uri) => explainFile(index, uri)),
    vscode.commands.registerCommand('codesense.showProjectMap', () => ProjectMapPanel.show(context, index)),

    // Keep the index fresh without re-scanning the whole workspace.
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!SOURCE_FILE.test(doc.fileName)) { return; }
      index.update(doc.fileName, doc.getText());
      // Debounce map refreshes so "Save All" doesn't redraw 20 times.
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => ProjectMapPanel.refresh(), 400);
    }),
    // Files created, deleted or renamed outside the editor: rescan lazily.
    vscode.workspace.onDidCreateFiles(() => index.build().then(() => ProjectMapPanel.refresh())),
    vscode.workspace.onDidDeleteFiles(() => index.build().then(() => ProjectMapPanel.refresh())),
    vscode.workspace.onDidRenameFiles(() => index.build().then(() => ProjectMapPanel.refresh())),
    { dispose: () => clearTimeout(refreshTimer) },
  );
}

export function deactivate(): void {}
