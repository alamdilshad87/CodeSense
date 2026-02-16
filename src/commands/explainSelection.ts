import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeFile, symbolsInRange } from '../analysis/fileAnalyzer';
import { explainWithLlm, readLlmConfig } from '../llm/provider';
import { ExplanationPanel } from '../ui/explanationPanel';

export async function explainSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('CodeSense: select some code first.');
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const code = doc.getText(sel);
  const title = `${path.basename(doc.fileName)}:${sel.start.line + 1}-${sel.end.line + 1}`;
  ExplanationPanel.loading(title);

  // Static context: what the selection declares/calls, and where those names come from.
  const isJsTs = /\.[jt]sx?$/.test(doc.fileName);
  let context = '';
  if (isJsTs) {
    const fileInfo = analyzeFile(doc.fileName, doc.getText());
    const { declared, called } = symbolsInRange(
      doc.fileName, doc.getText(), doc.offsetAt(sel.start), doc.offsetAt(sel.end));

    const importedNames = new Map<string, string>();
    for (const imp of fileInfo.imports) {
      for (const n of imp.names) { importedNames.set(n.replace('* as ', ''), imp.from); }
    }
    const external = called
      .map(c => c.split('.')[0])
      .filter(root => importedNames.has(root))
      .map(root => `\`${root}\` (from \`${importedNames.get(root)}\`)`);

    context = [
      declared.length ? `- **Declares:** ${declared.map(d => `\`${d}\``).join(', ')}` : '',
      called.length ? `- **Calls:** ${called.slice(0, 15).map(c => `\`${c}\``).join(', ')}` : '',
      external.length ? `- **Uses imports:** ${[...new Set(external)].join(', ')}` : '',
      fileInfo.roles.length ? `- **File role:** ${fileInfo.roles.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  const cfg = readLlmConfig();
  if (!cfg.enabled) {
    ExplanationPanel.show(title, (context || '_No static facts for this language yet._') +
      '\n\n_Tip: enable `codesense.llm.enabled` in settings for a plain-English explanation._');
    return;
  }

  try {
    const prompt = [
      `Explain what this ${doc.languageId} code does, from \`${vscode.workspace.asRelativePath(doc.fileName)}\`.`,
      'Structure: **Summary** (1-2 sentences), **Step by step**, **Inputs / outputs / side effects**, **Gotchas**.',
      context ? `\nStatic analysis facts:\n${context}` : '',
      '\n```' + doc.languageId,
      code,
      '```',
    ].join('\n');
    const answer = await explainWithLlm(cfg, prompt);
    ExplanationPanel.show(title, answer + (context ? `\n\n---\n\n## Static analysis\n${context}` : ''));
  } catch (err) {
    ExplanationPanel.show(title, `**LLM error:** ${(err as Error).message}\n\n${context}`);
  }
}
