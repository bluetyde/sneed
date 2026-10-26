// Plain-language explanations for the codes the validator and the run layer use. The code stays visible (it is what
// the logs and the docs name); the sentence is what a student reads.

export const PROBLEM_HINTS: Record<string, string> = {
  E_SCHEMA: 'The model does not follow the SNEED model format, so it cannot be analysed.',
  E_ID_FORMAT: 'An ID must start with a letter or underscore and use only letters, digits, underscore and dash.',
  E_DUP_ID: 'Two nodes share one ID. Every basic event and gate needs its own ID.',
  E_PROB_RANGE: 'A probability must be a number from 0 to 1.',
  E_NO_TOP: 'The model has no top event. Select a node and choose "Make top event".',
  E_MISSING_REF: 'A gate points at something that does not exist. Remove that input or add the missing node.',
  E_CYCLE: 'A gate cannot depend on itself, directly or through other gates. Remove one of the connections in the loop.',
  E_GATE_ARITY: 'An AND or OR gate needs at least two inputs. Add an input, or remove the gate.',
  E_VOTE_RANGE: 'A K-of-N gate needs 2 <= K < N. (K = 1 is an OR gate and K = N is an AND gate, so use those instead.)',
  E_VOTE_DUP: 'A K-of-N gate cannot list the same input twice.',
  E_CCF_ASSUMPTION: 'The model\'s assumptions and its common-cause groups disagree. Make a group again, or delete the groups.',
  E_CCF_UNKNOWN_MEMBER: 'A common-cause group names something that is not a basic event of this model. Take it out of the group.',
  E_CCF_OVERLAP: 'A basic event is in two common-cause groups, or twice in one. An event can be in one group only.',
  E_CCF_TOO_SMALL: 'A common-cause group needs at least two basic events.',
  E_CCF_TOO_LARGE: 'A common-cause group can have at most eight basic events. Split it.',
  E_CCF_BETA_RANGE: 'Beta is a fraction of the failures: a number from 0 to 1.',
  E_CCF_UNEQUAL_Q: 'The members of a common-cause group must have one probability. Change the probability of one member and the others follow.',
  E_EXPORT_LIMIT: 'This K-of-N gate is too large to hand to the engine. Split it into smaller gates.',
  W_UNREACHABLE: 'This node is not connected to the top event. It is kept in the model but ignored by the analysis.',
  W_UNKNOWN_FIELD: 'The file has a field this editor does not know. It is kept as it is and ignored.',
  W_CCF_LARGE_Q: 'With a large probability the beta-factor expansion gives members a probability below the one you set. Lower the probability, or read the answer with that in mind.',
  W_LAYOUT_STALE: 'A stored position refers to a node that no longer exists. It has no effect on any result.',
};

export const REASON_TEXT: Record<string, string> = {
  cancelled: 'The run was cancelled before it finished.',
  timeout: 'The engine took too long and was stopped.',
  'engine-build-mismatch': 'The engine is not the build that was installed. Reinstall the runtime.',
  'engine-version-mismatch': 'The engine reported a version this editor was not tested with.',
  'method-mismatch': 'The engine did not use the method that was asked for.',
  'limit-not-reported': 'The engine did not say what limit it used, so the result cannot be trusted to be complete.',
  'limit-below-bound-completeness-unknown': 'The engine may have dropped some cut sets and nothing shows whether it did, so the result is not accepted.',
  'product-order-limit-effective': 'The engine dropped cut sets because of its size limit. The numbers shown are for diagnosis only.',
  'probability-inconsistent-with-cut-sets': 'The engine\'s probability does not match its own cut sets, so the result is not accepted.',
  'probability-out-of-range': 'The engine reported a probability outside 0 to 1.',
  'empty-result-inconsistent': 'The engine reported no cut sets for a model that must have some.',
  'too-many-events': 'The model has more basic events than the engine allows.',
  'toolchain-lock-mismatch': 'The installed runtime failed its integrity check.',
};

export const CAVEAT_TEXT: Record<string, string> = {
  'approximation-exceeds-1': 'The rare-event sum is above 1, so it is not a probability here: the approximation only works when probabilities are small. The probability itself is at most 1.',
};

export const METHOD_TEXT: Record<string, string> = {
  exact: 'Exact',
  'rare-event': 'Rare-event approximation',
  mcub: 'Min-cut upper bound',
};

/** What a reason code means; falls back to the code itself so nothing is ever hidden. */
export function reasonText(code: string): string {
  if (REASON_TEXT[code]) return REASON_TEXT[code]!;
  if (code.startsWith('too-many-events-with-groups:')) {
    const [counts = '', ids = ''] = code.slice(28).split(':');
    const [before = '?', after = '?'] = counts.split('>');
    return `The model has ${before} basic events, which the engine allows, but its common-cause groups (${ids.split(',').join(', ')}) add one shared event each, which makes ${after}: over the limit. Take a group or an event out.`;
  }
  if (code.startsWith('engine-exit-')) return `The engine stopped with an error (${code.slice(12)}).`;
  if (code.startsWith('engine-error:')) return `The engine refused the input (${code.slice(13)}).`;
  if (code.startsWith('report-')) return `The engine's report could not be read (${code.slice(7)}).`;
  return code;
}
