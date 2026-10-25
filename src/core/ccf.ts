// Common-cause groups (plan 15, section 4): a group is expanded into ordinary events and gates before the built-in engine runs.
// The expansion is the one place where the beta-factor model is defined. Callers validate the document first.
import type { NativeModel } from './model.js';

export const CCF_SUFFIX = '.CCF';
export const INDEPENDENT_SUFFIX = '.independent';

/** The id of the event that fails every member of group `groupId` at once. A dot cannot occur in a valid id, so it never clashes. */
export const groupEventId = (groupId: string): string => groupId + CCF_SUFFIX;
/** The id of the part of member `memberId` that fails alone. */
export const independentPartId = (memberId: string): string => memberId + INDEPENDENT_SUFFIX;

/** 15 significant digits, so that (1 - 0.1) * 0.1 is 0.09 and not 0.09000000000000001. Far below any tolerance of an oracle. */
const tidy = (x: number): number => Number(x.toPrecision(15));

/**
 * Member `i` of a group fails when its independent part `I_i` occurs (probability (1 - beta) * Q) or when the group event `C` occurs
 * (probability beta * Q, one event for the whole group). Q is the one probability the members share.
 * The member keeps its id and becomes an OR gate, so every gate that named it, and the top event, still do.
 * A model without groups is returned as it is.
 */
export function expandGroups(model: NativeModel): NativeModel {
  const groups = model.common_cause_groups ?? [];
  if (groups.length === 0) return model;
  const probability = new Map(model.events.map((e) => [e.id, e.probability]));
  const memberIds = new Set(groups.flatMap((g) => g.members));
  const events = model.events.filter((e) => !memberIds.has(e.id));
  const gates = [...model.gates];
  for (const g of groups) {
    const q = probability.get(g.members[0]!);
    if (q === undefined) throw new RangeError(`group ${g.id} has a member that is not an event`);
    events.push({ id: groupEventId(g.id), probability: tidy(g.beta * q) });
    for (const m of g.members) {
      const qm = probability.get(m);
      if (qm === undefined || qm !== q) throw new RangeError(`group ${g.id}: the members must be events with one probability`);
      events.push({ id: independentPartId(m), probability: tidy((1 - g.beta) * q) });
      gates.push({ id: m, type: 'or', inputs: [independentPartId(m), groupEventId(g.id)] });
    }
  }
  const { common_cause_groups: _groups, ...rest } = model;
  void _groups;
  return { ...rest, events, gates };
}
