# Contributing to CodeSense

## Development setup

Requires Node.js 22+.

```bash
git clone https://github.com/alamdilshad87/CodeSense.git
cd CodeSense
npm install
npm run compile
npm test
```

Press **F5** in VS Code to launch an Extension Development Host with CodeSense loaded.
Build an installable package with `npm run package`.

## How it works

1. **Parse**: `fileAnalyzer.ts` parses each file with the TypeScript Compiler API and collects imports (including re-exports, `require()` and dynamic `import()`), symbols, class members and decorators.
2. **Index**: `projectIndex.ts` resolves relative imports into a project-wide dependency graph and updates it incrementally on save.
3. **Analyze**: `graph.ts` finds circular dependencies (Tarjan's SCC), entry points, hubs and orphans.
4. **Present**: results appear in the explanation panel and the Project Map webview (`media/projectMap.js`, a hand-written force-directed layout).

## Project structure

```
src/
├── extension.ts             # activation, commands, file watchers
├── analysis/
│   ├── fileAnalyzer.ts      # AST → imports, symbols, roles
│   ├── projectIndex.ts      # workspace index + import resolution
│   └── graph.ts             # cycles, entry points, hubs, orphans
├── commands/                # Explain File / Explain Selection
├── llm/provider.ts          # OpenAI-compatible client
├── ui/                      # explanation panel, Project Map panel
└── test/                    # node:test unit tests
media/                       # Project Map script, styles, icon
```

## Pull requests

Open an issue first for bigger changes. Run `npm test` before submitting.
