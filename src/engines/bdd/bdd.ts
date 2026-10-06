// A small reduced ordered binary decision diagram (Bryant) for coherent fault trees, and Rauzy's minimal solutions.
// Written from the published algorithms. It shares no code with the SCRAM path, with the Open-PSA exporter or with the
// test-only enumeration oracle, so that agreement between them means something (docs/plans/10-builtin-solver.md).
//
// Only monotone operations exist (AND, OR, K-of-N built from them): a coherent tree never needs negation.
// Every long loop charges a step counter and calls `tick`, which is how a time limit or a cancel reaches in here.

export const FALSE = 0;
export const TRUE = 1;

export class SolveAborted extends Error {
  constructor(readonly why: 'timeout' | 'cancelled' | 'too-many-nodes' | 'too-many-cut-sets' | 'too-many-events' | 'too-much-memory' | 'numeric-range' | 'sequences-do-not-partition') {
    super(`solve stopped: ${why}`);
  }
}

export interface BddLimits {
  /** Most diagram nodes that may exist. */
  maxNodes: number;
  /** Most minimal cut sets that may be produced. */
  maxCutSets: number;
  /** Most numbers the minimal-cut-set cache may hold in total (every stored set, with its length). Bounds memory, not just count. */
  maxCached: number;
}

/** Node ids stay below this, so that a pair of ids is one exact number (a * SHIFT + b < 2^53). */
const SHIFT = 2 ** 26;
const POLL = 4096;

export class Bdd {
  /** Variable index of each node (terminals have a variable above every real one). */
  private v: number[] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  private lo: number[] = [0, 1];
  private hi: number[] = [0, 1];
  private unique = new Map<string, number>();
  private andMemo = new Map<number, number>();
  private orMemo = new Map<number, number>();
  private notMemo = new Map<number, number>();
  private steps = 0;

  constructor(
    readonly limits: BddLimits,
    private readonly tick: () => void = () => undefined,
  ) {
    if (limits.maxNodes >= SHIFT) throw new RangeError('maxNodes is too large');
  }

  get nodeCount(): number {
    return this.v.length;
  }

  private charge(n = 1): void {
    this.steps += n;
    if (this.steps >= POLL) {
      this.steps = 0;
      this.tick();
    }
  }

  /** The node (variable, low branch when it works, high branch when it fails), made unique and reduced. */
  mk(variable: number, low: number, high: number): number {
    if (low === high) return low;
    const key = `${variable},${low},${high}`;
    const hit = this.unique.get(key);
    if (hit !== undefined) return hit;
    if (this.v.length >= this.limits.maxNodes) throw new SolveAborted('too-many-nodes');
    const id = this.v.length;
    this.v.push(variable);
    this.lo.push(low);
    this.hi.push(high);
    this.unique.set(key, id);
    return id;
  }

  /** The function that is true exactly when basic event `variable` has failed. */
  variable(variable: number): number {
    return this.mk(variable, FALSE, TRUE);
  }

  and(a: number, b: number): number {
    if (a === b) return a;
    if (a === FALSE || b === FALSE) return FALSE;
    if (a === TRUE) return b;
    if (b === TRUE) return a;
    if (a > b) [a, b] = [b, a];
    const key = a * SHIFT + b;
    const hit = this.andMemo.get(key);
    if (hit !== undefined) return hit;
    this.charge();
    const va = this.v[a]!;
    const vb = this.v[b]!;
    const top = Math.min(va, vb);
    const r = this.mk(
      top,
      this.and(va === top ? this.lo[a]! : a, vb === top ? this.lo[b]! : b),
      this.and(va === top ? this.hi[a]! : a, vb === top ? this.hi[b]! : b),
    );
    this.andMemo.set(key, r);
    return r;
  }

  or(a: number, b: number): number {
    if (a === b) return a;
    if (a === TRUE || b === TRUE) return TRUE;
    if (a === FALSE) return b;
    if (b === FALSE) return a;
    if (a > b) [a, b] = [b, a];
    const key = a * SHIFT + b;
    const hit = this.orMemo.get(key);
    if (hit !== undefined) return hit;
    this.charge();
    const va = this.v[a]!;
    const vb = this.v[b]!;
    const top = Math.min(va, vb);
    const r = this.mk(
      top,
      this.or(va === top ? this.lo[a]! : a, vb === top ? this.lo[b]! : b),
      this.or(va === top ? this.hi[a]! : a, vb === top ? this.hi[b]! : b),
    );
    this.orMemo.set(key, r);
    return r;
  }

  /**
   * Can the function be true for some assignment that respects `forced` (a variable index to 0 or 1, or undefined for a free variable)?
   * A yes or no about structure, with no probabilities in it: a product of many probabilities can underflow to 0, a path through the diagram cannot.
   */
  satisfiable(root: number, forced: (variable: number) => 0 | 1 | undefined): boolean {
    const memo = new Map<number, boolean>();
    const go = (n: number): boolean => {
      if (n === FALSE) return false;
      if (n === TRUE) return true;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      this.charge();
      const f = forced(this.v[n]!);
      const r = f === 0 ? go(this.lo[n]!) : f === 1 ? go(this.hi[n]!) : go(this.lo[n]!) || go(this.hi[n]!);
      memo.set(n, r);
      return r;
    };
    return go(root);
  }

  /**
   * The function that is true exactly when `a` is false. A negation is not coherent: the result is for evaluating probabilities of
   * conditions such as "this heading worked", never for cut sets (`minimalCutSets` is defined for coherent functions only).
   */
  not(a: number): number {
    if (a === FALSE) return TRUE;
    if (a === TRUE) return FALSE;
    const hit = this.notMemo.get(a);
    if (hit !== undefined) return hit;
    this.charge();
    const r = this.mk(this.v[a]!, this.not(this.lo[a]!), this.not(this.hi[a]!));
    this.notMemo.set(a, r);
    this.notMemo.set(r, a); // a negation undone is the original
    return r;
  }

  /**
   * True when at least k of the functions are true. For a monotone function: at least j of f[i..] holds when at least j of
   * f[i+1..] holds, or f[i] holds and at least j-1 of f[i+1..] holds.
   */
  atLeast(k: number, fs: number[]): number {
    const n = fs.length;
    if (k <= 0) return TRUE;
    if (k > n) return FALSE;
    // bottom-up over the inputs (no recursion, so a gate with thousands of inputs cannot exhaust the stack):
    // row[j] = "at least j of the inputs from i on", for j = 0..k
    let row: number[] = Array.from({ length: k + 1 }, (_, j) => (j === 0 ? TRUE : FALSE));
    for (let i = n - 1; i >= 0; i--) {
      const next = row.slice();
      for (let j = 1; j <= k; j++) {
        this.charge();
        next[j] = this.or(row[j]!, this.and(fs[i]!, row[j - 1]!));
      }
      row = next;
    }
    return row[k]!;
  }

  /** Probability that the function is true, for independent variables with failure probabilities `p`. */
  probability(root: number, p: number[]): number {
    const memo = new Map<number, number>();
    const go = (n: number): number => {
      if (n === FALSE) return 0;
      if (n === TRUE) return 1;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      this.charge();
      const q = p[this.v[n]!]!;
      const r = q * go(this.hi[n]!) + (1 - q) * go(this.lo[n]!);
      memo.set(n, r);
      return r;
    };
    return go(root);
  }

  /**
   * Probability that the function is false, computed on its own and not as 1 - probability(): when the function is almost certain,
   * the subtraction would round to 0 and lose every digit that matters (an OR of twenty events at 0.9 is false with probability 1e-20).
   */
  complement(root: number, p: number[]): number {
    const memo = new Map<number, number>();
    const go = (n: number): number => {
      if (n === FALSE) return 1;
      if (n === TRUE) return 0;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      this.charge();
      const q = p[this.v[n]!]!;
      const r = q * go(this.hi[n]!) + (1 - q) * go(this.lo[n]!);
      memo.set(n, r);
      return r;
    };
    return go(root);
  }

  /**
   * The minimal cut sets of a coherent function (Rauzy's minimal solutions): for a node on x with branches f0 (x works) and
   * f1 (x failed), the minimal sets are those of f0 together with x plus those of f1 that are not already sets of f0.
   * Each set is a list of variable indices in ascending order. Throws SolveAborted past the limits.
   */
  minimalCutSets(root: number): number[][] {
    if (root === FALSE) return [];
    if (root === TRUE) return [[]];
    const memo = new Map<number, number[][]>();
    let cached = 0;
    const go = (n: number): number[][] => {
      if (n === FALSE) return [];
      if (n === TRUE) return [[]];
      const hit = memo.get(n);
      if (hit) return hit;
      const low = go(this.lo[n]!);
      const high = go(this.hi[n]!);
      // The sets of the low branch are cut sets of the high branch too (the function is monotone), so no minimal set of the high
      // branch can strictly contain one of them: it can only be equal to one. Those are already counted in the low branch.
      const lowKeys = new Set(low.map((l) => l.join(',')));
      const kept = high.filter((s) => {
        this.charge();
        return !lowKeys.has(s.join(','));
      });
      const x = this.v[n]!;
      const result = low.concat(kept.map((s) => [x, ...s]));
      if (result.length > this.limits.maxCutSets) throw new SolveAborted('too-many-cut-sets');
      for (const s of result) cached += s.length + 1;
      if (cached > this.limits.maxCached) throw new SolveAborted('too-much-memory');
      memo.set(n, result);
      return result;
    };
    return go(root);
  }
}
