import * as ts from 'typescript';

export interface ImportInfo {
  from: string;          // module specifier, e.g. './utils' or 'react'
  names: string[];       // imported bindings
  isRelative: boolean;   // local file vs package
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable';
  exported: boolean;
  line: number;          // 1-based
  members?: string[];    // class methods/properties
  decorators?: string[]; // e.g. Component, Injectable (Angular)
}

export interface FileAnalysis {
  fileName: string;
  imports: ImportInfo[];
  symbols: SymbolInfo[];
  roles: string[];       // heuristic guesses: "Angular component", "Test file", ...
  lineCount: number;
}

/** Parse source text into a TypeScript AST. Works for .ts, .tsx, .js, .jsx. */
export function parse(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX
    : fileName.endsWith('.js') ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function decoratorNames(node: ts.Node): string[] {
  const decs = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return (decs ?? []).map(d => {
    const expr = d.expression;
    if (ts.isCallExpression(expr)) { return expr.expression.getText(); }
    return expr.getText();
  });
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function analyzeFile(fileName: string, text: string): FileAnalysis {
  const sf = parse(fileName, text);
  const imports: ImportInfo[] = [];
  const symbols: SymbolInfo[] = [];

  for (const stmt of sf.statements) {
    // --- imports ---------------------------------------------------------
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const from = stmt.moduleSpecifier.text;
      const names: string[] = [];
      const clause = stmt.importClause;
      if (clause?.name) { names.push(clause.name.text); }
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) { names.push(`* as ${nb.name.text}`); }
      if (nb && ts.isNamedImports(nb)) { nb.elements.forEach(e => names.push(e.name.text)); }
      imports.push({ from, names, isRelative: from.startsWith('.') });
      continue;
    }

    // --- re-exports: export { a } from './x' / export * from './x' -------
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const from = stmt.moduleSpecifier.text;
      const names = stmt.exportClause && ts.isNamedExports(stmt.exportClause)
        ? stmt.exportClause.elements.map(e => e.name.text)
        : ['*'];
      imports.push({ from, names, isRelative: from.startsWith('.') });
      continue;
    }

    // --- top-level declarations -----------------------------------------
    const exported = hasExportModifier(stmt);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      symbols.push({ name: stmt.name.text, kind: 'function', exported, line: lineOf(sf, stmt) });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const members = stmt.members
        .map(m => m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name)) ? m.name.text : undefined)
        .filter((n): n is string => !!n);
      symbols.push({
        name: stmt.name.text, kind: 'class', exported, line: lineOf(sf, stmt),
        members, decorators: decoratorNames(stmt),
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      symbols.push({ name: stmt.name.text, kind: 'interface', exported, line: lineOf(sf, stmt) });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      symbols.push({ name: stmt.name.text, kind: 'type', exported, line: lineOf(sf, stmt) });
    } else if (ts.isEnumDeclaration(stmt)) {
      symbols.push({ name: stmt.name.text, kind: 'enum', exported, line: lineOf(sf, stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const isFn = !!decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
          symbols.push({
            name: decl.name.text, kind: isFn ? 'function' : 'variable', exported, line: lineOf(sf, stmt),
          });
        }
      }
    }
  }

  // --- require('x') and dynamic import('x') anywhere in the file ---------
  const seen = new Set(imports.map(i => i.from));
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const from = node.arguments[0].text;
      if ((isRequire || isDynamicImport) && !seen.has(from)) {
        seen.add(from);
        imports.push({ from, names: [isRequire ? 'require' : 'import()'], isRelative: from.startsWith('.') });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return {
    fileName,
    imports,
    symbols,
    roles: guessRoles(fileName, imports, symbols),
    lineCount: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1,
  };
}

/** Cheap heuristics for "what is this file for?". The LLM refines this later. */
function guessRoles(fileName: string, imports: ImportInfo[], symbols: SymbolInfo[]): string[] {
  const roles: string[] = [];
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const decorators = symbols.flatMap(s => s.decorators ?? []);
  const fromPkg = (p: string) => imports.some(i => i.from === p || i.from.startsWith(p + '/'));

  if (/\.(test|spec)\.[jt]sx?$/.test(base)) { roles.push('Test file'); }
  if (/^index\.[jt]sx?$/.test(base)) { roles.push('Barrel / entry point'); }
  if (/(config|\.config)\.[jt]s$/.test(base)) { roles.push('Configuration'); }

  if (decorators.includes('Component')) { roles.push('Angular component'); }
  if (decorators.includes('Injectable')) { roles.push('Angular service'); }
  if (decorators.includes('NgModule')) { roles.push('Angular module'); }
  if (decorators.includes('Pipe')) { roles.push('Angular pipe'); }
  if (decorators.includes('Directive')) { roles.push('Angular directive'); }

  if (fromPkg('react') && /\.[jt]sx$/.test(base)) { roles.push('React component'); }
  if (fromPkg('express')) { roles.push('Express server / routes'); }

  const onlyTypes = symbols.length > 0 && symbols.every(s => s.kind === 'interface' || s.kind === 'type');
  if (onlyTypes) { roles.push('Type definitions'); }

  return roles;
}

/** Symbols declared or referenced inside a character range — used for "explain selection". */
export function symbolsInRange(fileName: string, text: string, start: number, end: number) {
  const sf = parse(fileName, text);
  const declared = new Set<string>();
  const called = new Set<string>();

  const visit = (node: ts.Node) => {
    if (node.getEnd() < start || node.getStart(sf) > end) { return; }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
         ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) &&
        node.name && ts.isIdentifier(node.name) && node.getStart(sf) >= start) {
      declared.add(node.name.text);
    }
    if (ts.isCallExpression(node) && node.getStart(sf) >= start) {
      called.add(node.expression.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { declared: [...declared], called: [...called] };
}
