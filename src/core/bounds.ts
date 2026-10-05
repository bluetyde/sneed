import type { NativeModel } from './model.js';

/**
 * Upper bound on the order (size) of any minimal cut set, from the structure alone.
 * AND adds the bounds of its distinct inputs, OR takes the largest, K-of-N adds the K largest.
 * Repeated references can only make real cut sets smaller, so this never under-estimates.
 * If the engine's product-order limit is at least this bound, no cut set can have been dropped.
 */
export function maxCutSetOrderBound(model: NativeModel): number {
  const gates = new Map(model.gates.map((g) => [g.id, g]));
  const memo = new Map<string, number>();
  const bound = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const g = gates.get(id);
    let b = 1;
    if (g) {
      const vals = [...new Set(g.inputs)].map(bound);
      if (g.type === 'and') b = vals.reduce((x, y) => x + y, 0);
      else if (g.type === 'or') b = Math.max(...vals);
      else {
        // duplicate inputs on a voting gate are refused by validation; sort descending and take k
        const k = g.threshold ?? vals.length;
        b = vals.sort((x, y) => y - x).slice(0, k).reduce((x, y) => x + y, 0);
      }
    }
    memo.set(id, b);
    return b;
  };
  return bound(model.top);
}

/** Basic events reachable from the top (the ones the engine will see). */
export function reachableEvents(model: NativeModel): string[] {
  const gates = new Map(model.gates.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const events = new Set<string>();
  const stack = [model.top];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = gates.get(id);
    if (g) stack.push(...g.inputs);
    else events.add(id);
  }
  return [...events].sort();
}
