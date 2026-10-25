// Analysing an event tree with the built-in engine (plan 13, stage S2): validate the document against the fault-tree model it names, run the
// sequences in a worker thread, and write the run folder and the result record. The record is of kind `sneed.event-tree-result`, never the
// fault-tree record. A failure is a record with a named reason and no numbers; nothing partial is ever written as an answer.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { documentHash, modelHash } from '../../core/canonical.js';
import { eventTreeHash, validateEventTreeText, type EtIssue } from '../../core/event-tree.js';
import { EVENT_TREE_RESULT_SCHEMA, eventTreeFailureText, type EtEndStateRow, type EtSequenceRow, type EventTreeResult } from '../../core/event-tree-result.js';
import type { NativeModel } from '../../core/model.js';
import { commonCauseRecord, expandGroups } from '../../core/ccf.js';
import { validateModelText } from '../../core/validate.js';
import { BDD_SOURCE_SHA256 } from './build-id.js';
import type { BddLimits } from './bdd.js';
import type { EventTreeInput } from './event-tree.js';
import { eventTreeIsolated } from './isolate.js';
import { BDD_ENGINE_NAME, BDD_ENGINE_VERSION } from './solve.js';

export interface EventTreeRunOptions {
  runsDir: string;
  signal?: AbortSignal;
  /** Milliseconds for the whole analysis (default 60000). */
  timeoutMs?: number;
  /** Also compute the labelled hand approximation (success branches ignored). */
  approximation?: boolean;
  limits?: Partial<BddLimits>;
  memoryMb?: number;
  runId?: string;
  now?: () => number;
}

export type EventTreeOutcome = { kind: 'refused'; errors: EtIssue[]; warnings: EtIssue[] } | { kind: 'ran'; runDir: string; record: EventTreeResult };

const NOTE = 'The traditional hand method: every "works" condition is dropped and only the failure events of the path are counted (together, so shared events are still counted once). It is a different kind of number from the exact frequency: the approximations do not add up to the initiating-event frequency.';

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, file);
}

const refuse = (code: EtIssue['code'], message: string): EventTreeOutcome => ({ kind: 'refused', errors: [{ code, severity: 'error', path: '/', message }], warnings: [] });

export async function analyzeEventTreeBuiltin(treeText: string, modelText: string, opts: EventTreeRunOptions): Promise<EventTreeOutcome> {
  const now = opts.now ?? ((): number => performance.now());
  const deadline = now() + (opts.timeoutMs ?? 60000);

  const modelCheck = validateModelText(modelText);
  if (!modelCheck.valid) return refuse('E_MODEL_NOT_FOUND', `the fault-tree model is not valid (${modelCheck.errors.map((e) => e.code).join(', ')}), so no sequence can be evaluated`);
  // common-cause groups (plan 15) are expanded into ordinary events and gates; the tree and the record name the original model
  const original = JSON.parse(modelText) as NativeModel;
  const model = expandGroups(original);
  const groups = original.common_cause_groups ?? [];

  // the tree is checked against exactly this model: the name it uses is the one it names
  let named = '';
  try {
    named = String((JSON.parse(treeText) as { fault_tree_model?: { name?: unknown } }).fault_tree_model?.name ?? '');
  } catch {
    /* not JSON: the validator says so */
  }
  const ref = { hash: modelHash(original), events: new Set(original.events.map((e) => e.id)), gates: new Set(original.gates.map((g) => g.id)) };
  const v = validateEventTreeText(treeText, { resolveModel: (n) => (n === named ? ref : null) });
  if (!v.valid) return { kind: 'refused', errors: v.errors, warnings: v.warnings };
  const doc = JSON.parse(treeText) as {
    initiating_event: { name: string; frequency: number; unit: string };
    headings: { id: string; name: string; event: string }[];
    end_states: { id: string; name: string; synthetic: boolean }[];
    sequences: EventTreeInput['sequences'];
    assumptions: Record<string, unknown>;
  };

  const treeHash = eventTreeHash(doc as never);
  const hashes = { tree_hash: treeHash, model_hash: ref.hash, document_hash: documentHash(Buffer.from(treeText, 'utf8')) };
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-et-${treeHash.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{8,}$/.test(runId)) throw new RangeError('runId must be at least 8 characters of [A-Za-z0-9_-]');
  const runDir = path.resolve(opts.runsDir, runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
  mkdirSync(path.join(runDir, 'native'), { recursive: true });
  writeFileSync(path.join(runDir, 'native', 'event-tree.json'), treeText, { encoding: 'utf8' }); // byte for byte as submitted
  writeFileSync(path.join(runDir, 'native', 'model.json'), modelText, { encoding: 'utf8' });

  const base = {
    schema: EVENT_TREE_RESULT_SCHEMA,
    quantity: 'sequence_frequency' as const,
    unit: 'per-year' as const,
    method: 'exact-joint' as const,
    assumptions: doc.assumptions,
    engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256, runtime: null },
    input_hashes: hashes,
    initiating_event: { name: doc.initiating_event.name, frequency: doc.initiating_event.frequency, unit: doc.initiating_event.unit },
    headings: doc.headings.map((h) => ({ id: h.id, name: h.name, event: h.event })),
    warnings: v.warnings.map((w) => w.message),
    ...(groups.length ? { common_cause: { method: 'beta-factor' as const, groups: commonCauseRecord(original).common_cause!.groups, note: 'The headings whose events are members of a common-cause group fail together with the stated beta. A different kind of result from one with independent events.' } } : {}),
    caveats: ['A frequency here is a model result under the stated assumptions, not a plant figure.', ...(groups.length ? ['The fault-tree model has common-cause groups (beta-factor): headings that share a group fail together, which the independent-events assumption above does not say. A different kind of result from one with independent events.'] : []), ...(doc.end_states.some((e) => e.synthetic) ? ['End states marked synthetic are examples, not conditions of any real plant.'] : [])],
  };
  const failed = (status: 'failed' | 'cancelled', reason: string): EventTreeOutcome => {
    const record: EventTreeResult = { ...base, status, completeness: 'unknown', reasons: [reason], sequences: [], end_states: [], total: null, approximation: null };
    writeAtomic(path.join(runDir, 'event-tree-results.json'), JSON.stringify(record, null, 2) + '\n');
    return { kind: 'ran', runDir, record };
  };

  if (opts.signal?.aborted) return failed('cancelled', 'cancelled');
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) return failed('failed', 'timeout');
  const answer = await eventTreeIsolated(model, doc, {
    timeoutMs: remaining,
    approximation: opts.approximation === true,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
  });
  if (!answer.ok) return answer.why === 'cancelled' ? failed('cancelled', 'cancelled') : failed('failed', answer.why);
  if (now() > deadline) return failed('failed', 'timeout'); // a last look: a result that arrived after the deadline is not accepted

  const c = answer.result;
  const sequences: EtSequenceRow[] = c.sequences.map((s) => ({
    key: s.key,
    path: s.path,
    end_state: s.end_state,
    probability: s.probability,
    frequency: s.frequency,
    share: s.probability,
    ...(s.approximation ? { approximation: { probability: s.approximation.probability, frequency: s.approximation.frequency, ratio_to_exact: s.approximation.ratio } } : {}),
  }));
  const names = new Map(doc.end_states.map((e) => [e.id, e]));
  const end_states: EtEndStateRow[] = c.endStates.map((e) => ({ id: e.id, name: names.get(e.id)!.name, synthetic: names.get(e.id)!.synthetic, frequency: e.frequency, probability: e.probability, sequences: e.sequences }));
  const record: EventTreeResult = {
    ...base,
    status: 'completed',
    completeness: 'complete',
    reasons: [],
    sequences,
    end_states,
    total: { frequency: c.total.frequency, probability_sum: c.total.probabilitySum, partition_error: c.total.partitionError },
    approximation: c.approximationFrequencySum === null ? null : { method: 'success-branches-ignored', note: NOTE, frequency_sum: c.approximationFrequencySum },
  };
  writeAtomic(path.join(runDir, 'event-tree-results.json'), JSON.stringify(record, null, 2) + '\n');
  return { kind: 'ran', runDir, record };
}

export { eventTreeFailureText };
