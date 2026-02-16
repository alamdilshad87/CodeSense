import * as vscode from 'vscode';

/**
 * A single reusable side panel that shows explanations.
 * Content is plain markdown-ish text rendered safely (escaped, minimal formatting).
 */
export class ExplanationPanel {
  private static current: ExplanationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      'codesense.explanation', 'CodeSense', vscode.ViewColumn.Beside,
      { enableScripts: false },
    );
    this.panel.onDidDispose(() => { ExplanationPanel.current = undefined; });
  }

  static show(title: string, markdown: string): void {
    if (!ExplanationPanel.current) { ExplanationPanel.current = new ExplanationPanel(); }
    const p = ExplanationPanel.current.panel;
    p.title = `CodeSense: ${title}`;
    p.webview.html = render(title, markdown);
    p.reveal(vscode.ViewColumn.Beside, true);
  }

  static loading(title: string): void {
    ExplanationPanel.show(title, '_Analyzing…_');
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tiny markdown subset: headings, bullets, `code`, **bold**, _italic_, ``` blocks. */
function mdToHtml(md: string): string {
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  for (const raw of md.split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escape(raw)); continue; }

    let line = escape(raw)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)_([^_]+)_/g, '$1<em>$2</em>');

    const bullet = /^\s*[-*]\s+(.*)/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }

    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) { out.push(`<h${h[1].length + 1}>${h[2]}</h${h[1].length + 1}>`); continue; }
    out.push(line.trim() ? `<p>${line}</p>` : '');
  }
  if (inList) { out.push('</ul>'); }
  if (inCode) { out.push('</code></pre>'); }
  return out.join('\n');
}

function render(title: string, md: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 0 16px 24px; line-height: 1.55; }
  h1 { font-size: 1.3em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  h2, h3, h4 { margin-top: 1.2em; }
  code { font-family: var(--vscode-editor-font-family);
         background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
</style></head>
<body><h1>${escape(title)}</h1>${mdToHtml(md)}</body></html>`;
}
