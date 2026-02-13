import { strict as assert } from 'assert';
import { test } from 'node:test';
import { Adjacency, cycleEdges, edgeKey, entryPoints, findCycles, hubs, orphans } from '../analysis/graph';

const graph = (edges: Record<string, string[]>): Adjacency =>
  new Map(Object.entries(edges).map(([k, v]) => [k, new Set(v)]));

test('finds no cycles in a DAG', () => {
  assert.deepEqual(findCycles(graph({ main: ['a', 'b'], a: ['c'], b: ['c'], c: [] })), []);
});

test('finds a simple two-file cycle', () => {
  const cycles = findCycles(graph({ a: ['b'], b: ['a'], c: ['a'] }));
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), ['a', 'b']);
});

test('finds a self-import and separate cycles', () => {
  const cycles = findCycles(graph({ a: ['a'], b: ['c'], c: ['d'], d: ['b'], e: [] }));
  const sorted = cycles.map(c => [...c].sort().join(',')).sort();
  assert.deepEqual(sorted, ['a', 'b,c,d']);
});

test('cycleEdges marks only edges inside a cycle', () => {
  const g = graph({ a: ['b'], b: ['a', 'c'], c: [] });
  const red = cycleEdges(g, findCycles(g));
  assert.ok(red.has(edgeKey('a', 'b')));
  assert.ok(red.has(edgeKey('b', 'a')));
  assert.ok(!red.has(edgeKey('b', 'c')));
});

test('entry points are un-imported files that import something, tests excluded', () => {
  const g = graph({ 'main.ts': ['a.ts'], 'a.ts': ['b.ts'], 'b.ts': [], 'a.test.ts': ['a.ts'] });
  assert.deepEqual(entryPoints(g, f => f.includes('.test.')), ['main.ts']);
});

test('orphans and hubs', () => {
  const g = graph({ m: ['u'], n: ['u'], u: [], lonely: [] });
  assert.deepEqual(orphans(g), ['lonely']);
  assert.deepEqual(hubs(g, 1), [{ file: 'u', importers: 2 }]);
});

test('handles a large chain without stack issues', () => {
  const edges: Record<string, string[]> = {};
  for (let i = 0; i < 2000; i++) { edges[`f${i}`] = i < 1999 ? [`f${i + 1}`] : []; }
  assert.deepEqual(findCycles(graph(edges)), []);
});
