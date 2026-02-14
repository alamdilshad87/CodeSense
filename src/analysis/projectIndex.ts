import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeFile, FileAnalysis } from './fileAnalyzer';
import { Adjacency } from './graph';

const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs}';
const EXCLUDE_GLOB = '**/{node_modules,out,dist,build,coverage,.git,.next,.angular}/**';
const MAX_FILES = 5000;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/**
 * Project-wide index: every source file's analysis plus the resolved
 * dependency graph (file -> local files it imports).
 */
export class ProjectIndex {
  private files = new Map<string, FileAnalysis>();
  private deps: Adjacency = new Map();
  private built = false;
  private building: Promise<void> | undefined;

  /** Full scan of the workspace. Concurrent callers share one scan. */
  build(): Promise<void> {
    if (!this.building) {
      this.building = this.doBuild().finally(() => { this.building = undefined; });
    }
    return this.building;
  }

  private async doBuild(): Promise<void> {
    const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, MAX_FILES);
    const files = new Map<string, FileAnalysis>();

    await Promise.all(uris.map(async uri => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        files.set(uri.fsPath, analyzeFile(uri.fsPath, Buffer.from(bytes).toString('utf8')));
      } catch {
        // Unreadable file: skip it rather than failing the whole index.
      }
    }));

    this.files = files;
    this.deps = new Map();
    for (const file of files.keys()) { this.linkFile(file); }
    this.built = true;
  }

  async ensureBuilt(): Promise<void> {
    if (!this.built) { await this.build(); }
  }

  /** Incremental update after a save: re-analyze one file and relink only its edges. */
  update(fsPath: string, text: string): void {
    if (!this.built) { return; }
    const isNew = !this.files.has(fsPath);
    this.files.set(fsPath, analyzeFile(fsPath, text));
    this.linkFile(fsPath);
    // A new file may satisfy imports that previously failed to resolve.
    if (isNew) { for (const f of this.files.keys()) { this.linkFile(f); } }
  }

  importersOf(fsPath: string): string[] {
    const result: string[] = [];
    for (const [from, targets] of this.deps) {
      if (targets.has(fsPath)) { result.push(from); }
    }
    return result;
  }

  get adjacency(): Adjacency { return this.deps; }
  get fileCount(): number { return this.files.size; }
  analysisOf(fsPath: string): FileAnalysis | undefined { return this.files.get(fsPath); }

  private linkFile(file: string): void {
    const analysis = this.files.get(file);
    const targets = new Set<string>();
    for (const imp of analysis?.imports ?? []) {
      if (!imp.isRelative) { continue; }
      const target = this.resolve(file, imp.from);
      if (target) { targets.add(target); }
    }
    this.deps.set(file, targets);
  }

  private resolve(fromFile: string, specifier: string): string | undefined {
    const base = path.resolve(path.dirname(fromFile), specifier);
    // ESM-style TS projects write './foo.js' for a './foo.ts' source.
    const stripped = base.replace(/\.(m|c)?js$/, '');
    for (const ext of EXTENSIONS) {
      for (const candidate of [base + ext, stripped + ext]) {
        if (this.files.has(candidate)) { return candidate; }
      }
    }
    return undefined;
  }
}
