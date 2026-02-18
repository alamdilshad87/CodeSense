import * as path from 'path';
import * as vscode from 'vscode';
import { cycleEdges, edgeKey, entryPoints, findCycles, hubs, inDegrees, orphans } from '../analysis/graph';
import { ProjectIndex } from '../analysis/projectIndex';

/** Shape sent to the webview. Keep in sync with media/projectMap.js. */
export interface MapPayload {
  nodes: { id: string; label: string; name: string; folder: string; inDeg: number; outDeg: number;
           lines: number; roles: string[]; inCycle: boolean }[];
  edges: { source: string; target: string; inCycle: boolean }[];
  cycles: string[][];
  entryPoints: string[];
  hubs: { id: string; importers: number }[];
  orphans: string[];
  fileCount: number;
}

const isTest = (f: string) => /\.(test|spec)\.[jt]sx?$/.test(f) || /[\\/](__tests__|test|tests)[\\/]/.test(f);

export function buildPayload(index: ProjectIndex): MapPayload {
  const adj = index.adjacency;
  const deg = inDegrees(adj);
  const cycles = findCycles(adj);
  const redEdges = cycleEdges(adj, cycles);
  const cycleMembers = new Set(cycles.flat());

  const nodes = [...adj.keys()].map(id => {
    const label = vscode.workspace.asRelativePath(id, false).replace(/\\/g, '/');
    const dir = path.posix.dirname(label);
    const parts = dir === '.' ? [] : dir.split('/');
    // Group by the first meaningful folder (skip a leading "src").
    const folder = parts[0] === 'src' ? (parts[1] ?? 'src') : (parts[0] ?? '(root)');
    return {
      id, label, name: path.basename(id), folder,
      inDeg: deg.get(id) ?? 0,
      outDeg: adj.get(id)?.size ?? 0,
      lines: index.analysisOf(id)?.lineCount ?? 0,
      roles: index.analysisOf(id)?.roles ?? [],
      inCycle: cycleMembers.has(id),
    };
  });

  const edges: MapPayload['edges'] = [];
  for (const [source, targets] of adj) {
    for (const target of targets) {
      edges.push({ source, target, inCycle: redEdges.has(edgeKey(source, target)) });
    }
  }

  return {
    nodes, edges, cycles,
    entryPoints: entryPoints(adj, isTest),
    hubs: hubs(adj, 8).map(h => ({ id: h.file, importers: h.importers })),
    orphans: orphans(adj, isTest),
    fileCount: index.fileCount,
  };
}

export class ProjectMapPanel {
  private static current: ProjectMapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private ready = false;

  static async show(context: vscode.ExtensionContext, index: ProjectIndex): Promise<void> {
    if (ProjectMapPanel.current) {
      ProjectMapPanel.current.panel.reveal();
      return;
    }
    ProjectMapPanel.current = new ProjectMapPanel(context, index);
  }

  /** Called after saves so an open map stays in sync. */
  static refresh(): void {
    ProjectMapPanel.current?.send();
  }

  private constructor(private readonly context: vscode.ExtensionContext, private readonly index: ProjectIndex) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('codesense.projectMap', 'CodeSense: Project Map',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.panel.webview.html = this.html(media);
    this.panel.onDidDispose(() => { ProjectMapPanel.current = undefined; });

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg?.type) {
        case 'ready':
          this.ready = true;
          await this.send();
          break;
        case 'open':
          if (typeof msg.id === 'string') {
            await vscode.window.showTextDocument(vscode.Uri.file(msg.id), { viewColumn: vscode.ViewColumn.Beside });
          }
          break;
        case 'rescan':
          await this.index.build();
          await this.send();
          break;
      }
    });
  }

  private async send(): Promise<void> {
    if (!this.ready) { return; }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'CodeSense: indexing project…' },
      () => this.index.ensureBuilt(),
    );
    await this.panel.webview.postMessage({ type: 'graph', payload: buildPayload(this.index) });
  }

  private html(media: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const script = w.asWebviewUri(vscode.Uri.joinPath(media, 'projectMap.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(media, 'projectMap.css'));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>Project Map</title></head>
<body>
  <aside id="sidebar">
    <header>
      <h1>Project Map</h1>
      <div id="stats">Indexing…</div>
    </header>
    <input id="search" type="search" placeholder="Search files…" autocomplete="off">
    <div class="buttons">
      <button id="fit" title="Fit graph to view">Fit</button>
      <button id="labels" title="Toggle all labels">Labels</button>
      <button id="rescan" title="Re-scan the workspace">Rescan</button>
    </div>
    <section><h2>Folders</h2><ul id="legend"></ul></section>
    <section><h2>Start reading here</h2><p class="hint">Entry points: nothing imports them.</p><ul id="entries"></ul></section>
    <section><h2>Core modules</h2><p class="hint">Most imported files.</p><ul id="hubs"></ul></section>
    <section><h2>Circular dependencies</h2><ul id="cycles"></ul></section>
    <section><h2>Possibly unused</h2><p class="hint">No imports in or out.</p><ul id="orphans"></ul></section>
  </aside>
  <main id="stage">
    <svg id="graph"></svg>
    <div id="tooltip" hidden></div>
    <div id="help">Scroll to zoom · drag background to pan · drag nodes · click to open</div>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}
