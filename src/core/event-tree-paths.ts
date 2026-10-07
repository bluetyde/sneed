// The paths an event tree allows: pure code with no file or schema access, so the browser and the server share ONE definition of which
// sequences exist (docs/plans/13-event-trees.md). The validator and the engine import it through event-tree.ts.

export const MAX_HEADINGS = 12;
export const MAX_SEQUENCES = 4096;

export type Branch = 'works' | 'fails';
export interface PathStep {
  heading: string;
  branch: Branch;
}

// ---------------------------------------------------------------- paths

interface HeadingLike {
  id: string;
  asked_only_if?: { heading: string; branch: Branch };
}

/**
 * Every complete path through the headings, in heading order. A heading is asked on a path unless it has a condition and the heading the
 * condition names was not asked there or took the other branch (so a heading that depends on a heading that was itself not asked is not
 * asked either). A condition that names an unknown or later heading is never satisfied (the validator reports it separately).
 */
export function enumeratePaths(headings: HeadingLike[]): PathStep[][] {
  const out: PathStep[][] = [];
  if (headings.length > MAX_HEADINGS) return out;
  const walk = (i: number, path: PathStep[]): void => {
    if (out.length > MAX_SEQUENCES) return;
    if (i === headings.length) {
      out.push(path);
      return;
    }
    const h = headings[i]!;
    let asked = true;
    if (h.asked_only_if) {
      const earlier = path.find((s) => s.heading === h.asked_only_if!.heading);
      asked = earlier !== undefined && earlier.branch === h.asked_only_if.branch;
    }
    if (!asked) return walk(i + 1, path);
    walk(i + 1, [...path, { heading: h.id, branch: 'works' }]);
    walk(i + 1, [...path, { heading: h.id, branch: 'fails' }]);
  };
  walk(0, []);
  return out;
}

/** One string per path, for comparing and sorting: "A:works,B:fails". */
export const pathKey = (p: PathStep[]): string => p.map((s) => `${s.heading}:${s.branch}`).join(',');

/** The sequences the headings allow, each with the given end state (empty by default: the author must choose). */
export function skeletonSequences(headings: HeadingLike[], endState = ''): { path: PathStep[]; end_state: string }[] {
  return enumeratePaths(headings).map((path) => ({ path, end_state: endState }));
}

