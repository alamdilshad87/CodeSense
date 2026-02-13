/**
 * Pure graph algorithms over the file dependency graph.
 * No VS Code imports here, so everything is unit-testable with plain Node.
 */

export type Adjacency = Map<string, Set<string>>; // file -> files it imports

/**
 * Tarjan's strongly-connected-components algorithm, O(V + E).
 * Every SCC with more than one node (or a self-import) is a circular dependency.
 */
export function findCycles(adj: Adjacency): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strongConnect = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }

    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      const selfLoop = component.length === 1 && (adj.get(v)?.has(v) ?? false);
      if (component.length > 1 || selfLoop) { cycles.push(component.reverse()); }
    }
  };

  for (const v of adj.keys()) {
    if (!index.has(v)) { strongConnect(v); }
  }
  return cycles;
}

/** Edges whose both ends sit in the same cycle, so the map can draw them in red. */
export function cycleEdges(adj: Adjacency, cycles: string[][]): Set<string> {
  const result = new Set<string>();
  for (const cycle of cycles) {
    const members = new Set(cycle);
    for (const from of cycle) {
      for (const to of adj.get(from) ?? []) {
        if (members.has(to)) { result.add(edgeKey(from, to)); }
      }
    }
  }
  return result;
}

export function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

export function inDegrees(adj: Adjacency): Map<string, number> {
  const deg = new Map<string, number>();
  for (const v of adj.keys()) { deg.set(v, 0); }
  for (const targets of adj.values()) {
    for (const t of targets) { deg.set(t, (deg.get(t) ?? 0) + 1); }
  }
  return deg;
}

/**
 * Likely entry points: nothing imports them, but they import something.
 * Test files are excluded because they are leaves by design.
 */
export function entryPoints(adj: Adjacency, isTest: (f: string) => boolean = () => false): string[] {
  const deg = inDegrees(adj);
  return [...adj.keys()]
    .filter(v => (deg.get(v) ?? 0) === 0 && (adj.get(v)?.size ?? 0) > 0 && !isTest(v))
    .sort((a, b) => (adj.get(b)!.size - adj.get(a)!.size));
}

/** Files nothing imports and that import nothing: possibly dead code. */
export function orphans(adj: Adjacency, isTest: (f: string) => boolean = () => false): string[] {
  const deg = inDegrees(adj);
  return [...adj.keys()]
    .filter(v => (deg.get(v) ?? 0) === 0 && (adj.get(v)?.size ?? 0) === 0 && !isTest(v))
    .sort();
}

/** Most-imported files: the core modules a newcomer should read first. */
export function hubs(adj: Adjacency, limit = 10): { file: string; importers: number }[] {
  return [...inDegrees(adj)]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, importers]) => ({ file, importers }));
}
