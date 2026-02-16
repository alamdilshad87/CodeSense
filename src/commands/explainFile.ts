import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeFile, FileAnalysis } from '../analysis/fileAnalyzer';
import { ProjectIndex } from '../analysis/projectIndex';
import { explainWithLlm, readLlmConfig } from '../llm/provider';
import { ExplanationPanel } from '../ui/explanationPanel';

export async function explainFile(index: ProjectIndex, uri?: vscode.Uri): Promise<void> {
  // Invoked from the Explorer context menu (uri given) or from the editor (active file).
  const doc = uri
    ? await vscode.workspace.openTextDocument(uri)
    : vscode.window.activeTextEditor?.document;
  if (!doc) {
    vscode.window.showWarningMessage('CodeSense: open a file first.');
    return;
  }
  const name = path.basename(doc.fileName);
  ExplanationPanel.loading(name);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'CodeSense: indexing project…' },
    () => index.ensureBuilt(),
  );

  const analysis = analyzeFile(doc.fileName, doc.getText());
  const importers = index.importersOf(doc.fileName).map(f => vscode.workspace.asRelativePath(f));
  const staticReport = buildStaticReport(analysis, importers);

  const cfg = readLlmConfig();
  if (!cfg.enabled) {
    ExplanationPanel.show(name, staticReport +
      '\n\n_Tip: enable `codesense.llm.enabled` in settings for a plain-English summary._');
    return;
  }

  try {
    const prompt = [
      `Explain the responsibility of the file \`${vscode.workspace.asRelativePath(doc.fileName)}\` in its project.`,
      'Cover: its main purpose, key exports and how other files use it, and anything a newcomer should watch out for.',
      '',
      'Static analysis facts (trust these):',
      staticReport,
      '',
      'Source (may be truncated):',
      '```',
      doc.getText().slice(0, 12000),
      '```',
    ].join('\n');
    const answer = await explainWithLlm(cfg, prompt);
    ExplanationPanel.show(name, answer + '\n\n---\n\n## Static analysis\n' + staticReport);
  } catch (err) {
    ExplanationPanel.show(name, `**LLM error:** ${(err as Error).message}\n\n${staticReport}`);
  }
}

function buildStaticReport(a: FileAnalysis, importers: string[]): string {
  const lines: string[] = [];
  lines.push(`**${a.lineCount} lines** · ${a.symbols.length} top-level symbols · ${a.imports.length} imports`);
  if (a.roles.length) { lines.push(`**Likely role:** ${a.roles.join(', ')}`); }

  const exported = a.symbols.filter(s => s.exported);
  if (exported.length) {
    lines.push('', '## Exports');
    for (const s of exported) {
      const deco = s.decorators?.length ? ` @${s.decorators.join(' @')}` : '';
      const members = s.members?.length ? ` with ${s.members.length} members` : '';
      lines.push(`- \`${s.name}\` (${s.kind}${deco}${members}), line ${s.line}`);
    }
  }

  const internal = a.symbols.filter(s => !s.exported);
  if (internal.length) {
    lines.push('', '## Internal helpers');
    for (const s of internal) { lines.push(`- \`${s.name}\` (${s.kind}), line ${s.line}`); }
  }

  const local = a.imports.filter(i => i.isRelative);
  const pkgs = a.imports.filter(i => !i.isRelative);
  if (local.length || pkgs.length) {
    lines.push('', '## Depends on');
    for (const i of local) { lines.push(`- \`${i.from}\`: ${i.names.join(', ') || '(side effect)'}`); }
    if (pkgs.length) { lines.push(`- Packages: ${pkgs.map(p => `\`${p.from}\``).join(', ')}`); }
  }

  lines.push('', '## Used by');
  if (importers.length) {
    for (const f of importers) { lines.push(`- \`${f}\``); }
  } else {
    lines.push('- _No local importers found. This may be an entry point, a test, or unused._');
  }
  return lines.join('\n');
}
