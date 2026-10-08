"""Tests of the verifier (plan 05): break the validator, schema, hash code or test oracle on purpose and require the unit tests to fail.

Each mutation is applied to one file, `npx vitest run` is executed, and the original bytes are restored in a
`finally` block. A mutation that leaves the suite green is a gap in the tests and fails this script. A run that
exceeds TIMEOUT is killed and reported separately: it is a hang, not a clean failure, so it should be fixed.
A hard kill skips `finally`, so originals are also stashed in tests/mutation/.backup and restored on the next start.
Run from the repository root: python tests/mutation/verifier_mutations.py
"""
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
BACKUP = HERE / ".backup"

V = ROOT / "src/core/validate.ts"
S = ROOT / "schema/model.schema.json"
C = ROOT / "src/core/canonical.ts"
E = ROOT / "tests/oracle/enumerate.ts"
R = ROOT / "tests/oracle/rational.ts"
X = ROOT / "src/core/export.ts"
P = ROOT / "src/core/report.ts"
Rs = ROOT / "src/core/result.ts"
AN = ROOT / "src/core/analyze.ts"
B = ROOT / "src/core/bounds.ts"
A = ROOT / "src/core/analyze.ts"
N = ROOT / "src/core/engine.ts"
RC = ROOT / "src/runtime/recipe.ts"
RT = ROOT / "src/runtime/install.ts"
SM = ROOT / "src/runtime/smoke.ts"
RV = ROOT / "src/runtime/resolve.ts"
WD = ROOT / "src/web/model/doc.ts"
WV = ROOT / "src/web/model/visual.ts"
WE = ROOT / "src/web/model/editor.ts"
WC = ROOT / "src/web/ui/canvas.ts"
WP = ROOT / "src/web/ui/properties.ts"
WS = ROOT / "src/web/ui/shell.ts"
WR = ROOT / "src/web/ui/results.ts"
WL = ROOT / "src/web/ui/lesson.ts"
CM = ROOT / "src/core/compare.ts"
SR = ROOT / "src/server/runs.ts"
WK = ROOT / "src/web/ui/compare.ts"
LS = ROOT / "src/core/lesson.ts"
SL = ROOT / "src/server/lessons.ts"
HL = ROOT / "src/cli/headless.ts"
SO = ROOT / "scripts/lib/seed-oracles.ts"
BI = ROOT / "src/engines/bdd/isolate.ts"
BD = ROOT / "src/engines/bdd/bdd.ts"
BV = ROOT / "src/engines/bdd/solve.ts"
BA = ROOT / "src/engines/bdd/analyze.ts"
XC = ROOT / "src/engines/crosscheck.ts"
SA = ROOT / "src/server/app.ts"
ST = ROOT / "src/server/storage.ts"

# Test selection and time limit (seconds) per mutation. Engine suites need WSL and the pinned SCRAM build.
UNIT = ("tests/unit", 180)
PROCESS = ("tests/engine/process.test.ts", 420)
HEADLESS = ("tests/engine/headless.test.ts", 1500)
SMOKE = ("tests/engine/smoke.test.ts", 900)
TIMEOUT = ("tests/engine/analyze-timeout.test.ts", 400)
E2E = ("cmd:npm run e2e --silent", 600)  # builds the web app from the mutated source, then drives real Chrome

MUTATIONS = [
    ("cycle detection off", V, "if (c === 1) {", "if (false as boolean) {"),
    ("and/or arity off by one", V, "if (n < 2) errors.push", "if (n < 1) errors.push"),
    ("vote range accepts k = n", V, "k < 2 || k >= n", "k < 2 || k > n"),
    ("vote range accepts k = 1", V, "k < 2 || k >= n", "k < 1 || k >= n"),
    ("vote duplicate check off", V, "if (new Set(g.inputs).size !== n) {", "if (false as boolean) {"),
    ("duplicate id check off", V, "if (prior) {", "if (false as boolean) {"),
    ("missing reference check off", V, "if (!kinds.has(inp)) errors.push(issue('E_MISSING_REF'", "if (false as boolean) errors.push(issue('E_MISSING_REF'"),
    ("probability reported as E_SCHEMA", V, "return issue('E_PROB_RANGE', path,", "return issue('E_SCHEMA', path,"),
    ("id format reported as E_SCHEMA", V, "return issue('E_ID_FORMAT',", "return issue('E_SCHEMA',"),
    ("missing top reported as E_SCHEMA", V, "return issue('E_NO_TOP', '/top', missing", "return issue('E_SCHEMA', '/top', missing"),
    ("unknown-field warning off", V, "if (!known.includes(k)) out.push", "if (false as boolean) out.push"),
    ("unreachable warning off", V, "if (!seen.has(id)) warnings.push", "if (false as boolean) warnings.push"),
    ("stale layout warning off", V, "!kinds.has(n.id)) warnings.push", "false as boolean) warnings.push"),
    ("only first error reported", V, "const e2 = unique(errors);", "const e2 = unique(errors).slice(0, 1);"),
    ("schema: id pattern allows dots", S, "[A-Za-z0-9_-]{0,62}[A-Za-z0-9_]", "[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_]"),
    ("schema: probability maximum loosened", S, '"maximum": 1', '"maximum": 100'),
    ("schema: threshold allowed on and/or", S, '"then": { "properties": { "threshold": false } }', '"then": {}'),
    ("schema: independence assumption loosened", S, '"independence": { "const": "declared-independent" }', '"independence": {}'),
    ("hash: inputs not sorted", C, "inputs: [...g.inputs].sort()", "inputs: [...g.inputs]"),
    ("hash: keys not sorted", C, "Object.keys(o).sort()", "Object.keys(o)"),
    ("hash: duplicate ids accepted", C, "if (Object.hasOwn(events, e.id)) throw", "if (false as boolean) throw"),
    ("oracle: AND evaluated as OR", E, "g.type === 'and' ? (count === g.ins.length ? 1 : 0)", "g.type === 'and' ? (count > 0 ? 1 : 0)"),
    ("oracle: voting uses > instead of >=", E, ": count >= g.k ? 1 : 0;", ": count > g.k ? 1 : 0;"),
    ("oracle: working-state probability wrong", E, "den[i]! - pa[i]!.a", "pa[i]!.a"),
    ("oracle: cut-set minimality check off", E, "if ((mask >> b) & 1 && topTrue[mask & ~(1 << b)]) minimal = false;", "if (false as boolean) minimal = false;"),
    ("oracle: unreachable events included", E, "visit(doc.top);", "visit(doc.top); for (const e of doc.events) reachableEvents.add(e.id);"),
    ("oracle: rare-event sum drops terms", E, "rare = rare.add(p);", "rare = rare.add(Q.ZERO);"),
    ("oracle: MCUB multiplies p not 1-p", E, "survive = survive.mul(Q.ONE.sub(p));", "survive = survive.mul(p);"),
    ("oracle: event limit raised to 17", E, "export const MAX_EVENTS = 16;", "export const MAX_EVENTS = 17;"),
    ("oracle: accepts invalid models", E, "if (!check.valid) throw", "if (false as boolean) throw"),
    ("oracle: cut-set probability ignores events", E, "set.reduce((acc, id) => acc.mul(pOf(id)), Q.ONE)", "set.reduce((acc) => acc.mul(Q.ONE), Q.ONE)"),
    ("oracle: inclusion-exclusion sign flipped", E, "sum = bits % 2 ? sum.add(term) : sum.sub(term);", "sum = bits % 2 ? sum.sub(term) : sum.add(term);"),
    ("oracle: second evaluator AND as OR", E, "bits.every(Boolean)", "bits.some(Boolean)"),
    ("oracle: second evaluator voting off by one", E, "t >= (g.threshold ?? Infinity)", "t > (g.threshold ?? Infinity)"),
    ("rational: subtraction adds", R, "Q.make(this.n * o.d - o.n * this.d, this.d * o.d)", "Q.make(this.n * o.d + o.n * this.d, this.d * o.d)"),
    ("rational: exponent ignored when parsing", R, "let s = frac.length - Number(m[4] ?? '0');", "let s = frac.length;"),
    # exporter
    ("export: duplicate inputs not collapsed", X, "if (distinct.length === 1) out = distinct[0]!;", "if (distinct.length === 0) out = distinct[0]!;"),
    ("export: repeated and/or inputs kept", X, "args: [...new Set(ins)].map((ref) => ({ ref }))", "args: ins.map((ref) => ({ ref }))"),
    ("export: wrapper may reuse a native gate id", X, " || gateById.has(name); i++)", "; i++)"),
    ("export: unreachable gates exported", X, "visit(topResolved);", "visit(topResolved); model.gates.forEach((g) => visit(g.id));"),
    ("export: voting threshold off by one", X, "f = { op: 'atleast', min: k, args: ins.map", "f = { op: 'atleast', min: k - 1, args: ins.map"),
    ("export: vote expansion joins with AND", X, "f = terms.length === 1 ? terms[0]! : { op: 'or', args: terms };", "f = terms.length === 1 ? terms[0]! : { op: 'and', args: terms };"),
    ("export: auto mode always native", X, "(voting === 'auto' && allEvents)", "(voting === 'auto')"),
    ("export: vote expansion limit disabled", X, "choose(ins.length, k) > MAX_VOTE_TERMS", "choose(ins.length, k) > MAX_VOTE_TERMS * 1e9"),
    ("export: probability may be written with an exponent", X, "if (!m) return t;", "return t;"),
    ("export: gate order depends on input order", X, "for (const id of [...emittedGates].sort()) {", "for (const id of [...emittedGates]) {"),
    # report parser
    ("report: DOCTYPE accepted", P, "/<!DOCTYPE|<!ENTITY|<!\\[CDATA\\[/i", "/<!ENTITY|<!\\[CDATA\\[/i"),
    ("report: numbers not validated", P, "if (text === undefined || !/^", "if (text === undefined || false && !/^"),
    ("report: several sum-of-products accepted", P, "if (sums.length !== 1)", "if (sums.length < 1)"),
    ("report: engine version not read", P, "if (!name || !version)", "if (!name)"),
    # result assessment
    ("result: cancellation ignored", Rs, "if (input.outcome.cancelled) return", "if (false as boolean) return"),
    ("result: timeout ignored", Rs, "if (input.outcome.timedOut) return fail('timeout');", "if (false as boolean) return fail('timeout');"),
    ("result: nonzero exit ignored", Rs, "if (input.outcome.exit !== 0) {", "if (false as boolean) {"),
    ("result: engine version not checked", Rs, "report.software.version !== input.expectedVersion", "false as boolean"),
    ("result: method not checked", Rs, "if (report.approximation !== APPROXIMATION[settings.method])", "if (false as boolean)"),
    ("result: unknown event in cut set accepted", Rs, "else if (ev.some((e) => !known.has(e)))", "else if (false as boolean)"),
    ("result: cut-set probability not checked", Rs, "|| !close(prod.probability, expected)", "|| false as boolean"),
    ("result: any limit accepted as ample", Rs, "if (limit >= needed) {", "if (limit >= 0) {"),
    ("result: exact probability not checked against cut sets", Rs, "if (union !== null && union > report.probability && !close(union, report.probability)) {", "if (false as boolean) {"),
    ("result: omission evidence ignored", Rs, "if (emptyButPossible || explainsLess) {", "if (false as boolean) {"),
    ("result: approximation values not recomputed", Rs, "if (reasons.length === 0 && settings.method !== 'exact') {", "if (false as boolean) {"),
    ("result: non-minimal cut sets accepted", Rs, "&& hasNonMinimal(sets, check)) reasons.push('non-minimal-cut-sets');", "&& (false as boolean)) reasons.push('non-minimal-cut-sets');"),
    ("result: clamp warning ignored for exact", Rs, "if (adjusted && settings.method === 'exact' && !close(report.probability, 1))", "if (false as boolean)"),
    # structural bound
    ("bounds: AND takes the maximum", B, "if (g.type === 'and') b = vals.reduce((x, y) => x + y, 0);", "if (g.type === 'and') b = Math.max(...vals);"),
    ("bounds: OR takes the sum", B, "else if (g.type === 'or') b = Math.max(...vals);", "else if (g.type === 'or') b = vals.reduce((x, y) => x + y, 0);"),
    # run layer (need the engine)
    ("analyze: validation skipped", A, "if (!validation.valid) return", "if (false as boolean) return", HEADLESS),
    ("analyze: default limit is the engine's own 20", A, "limitOrder: Math.max(1, events.length)", "limitOrder: 20", HEADLESS),
    ("analyze: engine pin not enforced", A, "if (engineCfg.expectedSha256 && identity.sha256 !== engineCfg.expectedSha256) {", "if (false as boolean) {", HEADLESS),
    ("analyze: always writes SCRAM's atleast", A, "exportOpenPsa(model, opts.voting ? { voting: opts.voting } : {})", "exportOpenPsa(model, { voting: 'native' })", HEADLESS),
    ("analyze: report read even after the run failed to produce one", A, "const reportText = existsSync(reportPath) && !reportTooLarge ? readFileSync(reportPath, 'utf8') : null;", "const reportText = '<report/>';", HEADLESS),
    ("engine: cancel does not kill the owned process", N, "      killOwned(distro, opts.ownerTag);\n", "", PROCESS),
    ("engine: owner tag not regex-escaped", N, "const pattern = regexEscape(ownerTag);", "const pattern = ownerTag;", PROCESS),
    ("engine: timeout never fires", N, "const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);", "const timer = setTimeout(() => undefined, opts.timeoutMs);", PROCESS),
    ("engine: cancellation after exit still recorded", N, "      if (settled) return;\n      settled = true;\n      if (why", "      settled = true;\n      if (why", PROCESS),
    ("engine: owner tag length not checked", N, "export function killOwned(distro: string, ownerTag: string): void {\n  if (ownerTag.length < 12)", "export function killOwned(distro: string, ownerTag: string): void {\n  if (false as boolean)", PROCESS),
    ("engine: hasOwned accepts a short tag", N, "export function hasOwned(distro: string, ownerTag: string): boolean {\n  if (ownerTag.length < 12)", "export function hasOwned(distro: string, ownerTag: string): boolean {\n  if (false as boolean)", PROCESS),
    ("engine: regexEscape does not escape", N, r"return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');", "return text;"),
    # recipe loader
    ("recipe: shell steps accepted", RC, "if (SHELLS.has(base(s.argv[0]!)) || SHELLS.has(base(cmd)))", "if (false as boolean)"),
    ("recipe: shell hidden behind env accepted", RC, "while (i < argv.length && (argv[i]!.includes('=') || argv[i]!.startsWith('-'))) i++;", "while (false as boolean) i++;"),
    ("recipe: lock hash not checked", RC, "if (sha256(lockText) !== r.trust.toolchain_lock_sha256)", "if (false as boolean)"),
    ("recipe: lock entries without sha256 accepted", RC, "if (!LOCK_LINE.test(l))", "if (false as boolean)"),
    ("recipe: lock entries outside the channel accepted", RC, "else if (!l.startsWith(r.trust.toolchain_channel + '/'))", "else if (false as boolean)"),
    ("recipe: phase order unchecked", RC, "if (PHASE_ORDER[s.phase] < lastPhase)", "if (false as boolean)"),
    ("recipe: unknown placeholders accepted", RC, "if (!(PLACEHOLDERS as readonly string[]).includes(name))", "if (false as boolean)"),
    ("recipe: parent traversal accepted", RC, "if (a.split('/').includes('..'))", "if (false as boolean)"),
    ("recipe: absolute paths outside the prefix accepted", RC, "if (a.startsWith('/') && !SYSTEM_TOOL_DIRS.some((d) => a.startsWith(d)))", "if (false as boolean)"),
    ("recipe: unverified checkout accepted", RC, "if (!r.steps.some((s) => s.expect_stdout_equals === '${SOURCE_COMMIT}'))", "if (false as boolean)"),
    # runner
    ("install: bad linux root not checked at start", RT, "assertLinuxRoot(env.linuxRoot); // before any file or process is created", "// removed"),
    ("install: managed-prefix check off", RT, "if (!PREFIX_NAME.test(name) || prefix.includes('..'))", "if (false as boolean)"),
    ("install: lock copy mismatch ignored", RT, "|| !copySum.stdout.startsWith(loaded.lockSha256 + ' '))", "|| false as boolean)"),
    ("install: free space ignored", RT, "if (free < recipe.sizes.required_free_bytes)", "if (false as boolean)"),
    ("install: step failure ignored", RT, "if (r.exit !== 0) return await finish('failed', [`step-failed:${step.id}`, `exit-${r.exit}`]);", "if (false as boolean) return await finish('failed', [`step-failed:${step.id}`, `exit-${r.exit}`]);"),
    ("install: step timeout ignored", RT, "if (r.timedOut) return await finish('failed', [`step-timeout:${step.id}`]);", "if (false as boolean) return await finish('failed', [`step-timeout:${step.id}`]);"),
    ("install: step expectation ignored", RT, "if (step.expect_stdout_equals !== undefined && out !== expand(step.expect_stdout_equals, vars))", "if (false as boolean)"),
    ("install: smoke failure ignored", RT, "if (!results.every((s) => s.passed))", "if (false as boolean)"),
    ("install: cancel after smoke ignored", RT, "if (cancelled()) return await finish('cancelled', ['cancelled']);\n    if (!results.every", "if (false as boolean) return await finish('cancelled', ['cancelled']);\n    if (!results.every"),
    ("install: failed prefix always kept", RT, "if (opts.keepFailed && record.state === 'failed') return;", "return;"),
    ("install: stale lock never taken over", RT, "if (!isStaleLock(env)) throw new RuntimeBusyError(", "if (true as boolean) throw new RuntimeBusyError("),
    ("install: lock never counts as stale", RT, "return nowMs - ref > STALE_AFTER_MS;", "return nowMs - ref > STALE_AFTER_MS * 1e9;"),
    ("recover: live install's lock taken over", RT, "if (existsSync(lockFile) && !isStaleLock(env)) return touched; // a live install owns it", ""),
    ("recover: finished installs marked interrupted", RT, "if (!rec || TERMINAL.includes(rec.state)) continue;", "if (!rec) continue;"),
    ("recover: owned processes not stopped before delete", RT, "await runner(['/usr/bin/pkill', '-KILL', '-f', '--', regexEscape(rec.prefix)], { timeoutMs: 60000, ownerTag: rec.prefix });", ""),
    ("verify: manifest hash not compared", RT, "if (sha256(readFileSync(manifestFile)) !== active.manifest_sha256) return [{ code: 'manifest-changed'", "if (false as boolean) return [{ code: 'manifest-changed'"),
    ("verify: binary hash not compared", RT, "if (!sum.stdout.startsWith(m.binary.sha256 + ' '))", "if (false as boolean)"),
    ("verify: version not compared", RT, "|| ver.stdout.trim() !== m.binary.version_text)", "|| false as boolean)"),
    ("resolve: manifest integrity not checked", RV, "|| sha256(readFileSync(manifestFile)) !== active.manifest_sha256) throw new Error('the active runtime manifest is missing or changed');", ") throw new Error('the active runtime manifest is missing or changed');"),
    ("rollback: previous runtime not verified", RT, "if (issues.length) throw new Error(`the previous runtime does not verify", "if (false as boolean) throw new Error(`the previous runtime does not verify"),
    ("rollback: allowed while an install holds the lock", RT, "if (existsSync(path.join(dir, 'lock.json'))) throw new RuntimeBusyError(", "if (false as boolean) throw new RuntimeBusyError("),
    ("resolve: a missing runtime is not reported", RV, "if (!active) throw new RuntimeNotInstalledError(env.stateDir);", "if (false as boolean) throw new RuntimeNotInstalledError(env.stateDir);"),
    ("resolve: wrong default Linux root", RV, "vars.SNEED_RUNTIME_ROOT ?? '/root/sneed-runtime'", "vars.SNEED_RUNTIME_ROOT ?? '/root/other'"),
    ("resolve: environment ignored", RV, "distro: vars.SNEED_WSL_DISTRO ?? 'Ubuntu',", "distro: 'Ubuntu',"),
    ("result: sum above 1 not labelled", Rs, "if (close(report.probability, 1)) caveats.push('approximation-exceeds-1');", "if (close(report.probability, 1)) void 0;"),
    ("result: any printed value accepted for a sum above 1", Rs, "if (close(report.probability, 1)) caveats.push('approximation-exceeds-1');\n      else reasons.push('probability-inconsistent-with-cut-sets');", "caveats.push('approximation-exceeds-1');"),
    ("result: approximation value not recorded", Rs, "approximation_value: approximationValue,", "approximation_value: null,"),
    # editor logic (unit) and server safety (unit)
    ("web doc: delete leaves references to the deleted node", WD, "for (const g of d.gates) g.inputs = g.inputs.filter((x) => x !== id);", ""),
    ("web doc: disconnect removes every occurrence", WD, "if (g && index >= 0 && index < g.inputs.length) g.inputs.splice(index, 1);", "if (g && index >= 0 && index < g.inputs.length) g.inputs = g.inputs.filter((x) => x !== g.inputs[index]);"),
    ("web doc: ids are reused while still in use", WD, "if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;", "return `${prefix}${n}`;"),
    ("web doc: a gate arrives with one event", WD, "const count = type === 'atleast' ? 3 : 2;", "const count = 1;"),
    ("web doc: AND/OR keep a leftover threshold", WD, "else delete g.threshold;", ";"),
    ("web doc: a broken file is silently repaired", WD, "if (!Array.isArray(d.events) || !Array.isArray(d.gates)) throw", "if (false as boolean) throw"),
    ("web visual: a repeated id is drawn as a second node", WV, "} else if (placed.has(id)) {", "} else if (false as boolean) {"),
    ("web visual: stored positions ignored", WV, "if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {", "if (false as boolean) {"),
    ("web visual: parents not centred over inputs", WV, "n.x = (first.x + last.x) / 2;", "n.x = first.x;"),
    ("editor: a result never goes stale on a model change", WE, "return r.input_hashes.model_hash !== this.validation?.model_hash || r.method !== this.method || this.resultEngine !== this.engine;", "return r.method !== this.method || this.resultEngine !== this.engine;"),
    ("editor: a result never goes stale on a method change", WE, "return r.input_hashes.model_hash !== this.validation?.model_hash || r.method !== this.method || this.resultEngine !== this.engine;", "return r.input_hashes.model_hash !== this.validation?.model_hash || this.resultEngine !== this.engine;"),
    ("editor: run ignores problems", WE, "if (blocked) return this.setNotice('warning', `Run blocked: ${blocked}.`);", "if (false as boolean) return this.setNotice('warning', `Run blocked: ${blocked}.`);"),
    ("editor: an edit keeps the redo stack", WE, "    this.redoStack = [];\n    this.doc = next;", "    this.doc = next;"),
    ("editor: deleting a reference deletes the node it points at", WE, "if ((n.kind === 'reference' || n.kind === 'missing') && n.parent) {", "if (false as boolean) {"),
    ("editor: an opened file counts as unsaved", WE, "this.savedText = this.text; // formatting differences are not unsaved work", "this.savedText = '';"),
    ("editor: undo forgets to redraw", WE, "    this.undoStack.push({ doc: this.doc, label: s.label });\n    this.doc = s.doc;\n    this.afterChange();", "    this.undoStack.push({ doc: this.doc, label: s.label });\n    this.doc = s.doc;"),
    ("server: Host header not checked", SA, "if (!allowedHosts().includes(hostHeader.toLowerCase()))", "if (false as boolean)"),
    ("server: foreign Origin allowed", SA, "if (origin !== undefined && !allowedOrigins().includes(origin))", "if (false as boolean)"),
    ("server: writes need no custom header", SA, "req.headers['x-sneed-request'] !== '1'", "false as boolean"),
    ("server: static files outside the web folder", SA, "if (!file.startsWith(path.resolve(root) + path.sep))", "if (false as boolean)"),
    ("server: internal errors leak their text", SA, "return send(res, 500, { error: { code: 'E_INTERNAL', message: 'internal error' } });", "return send(res, 500, { error: { code: 'E_INTERNAL', message: String((e as Error).message) } });"),
    ("server: disconnect does not stop the engine", SA, "if (!dequeue(job)) job.abort.abort();", "if (!dequeue(job)) void 0;"),
    ("server: runs are not held back", SA, "await acquire(job);", "running = job;"),
    ("storage: unsafe names accepted", ST, "if (!isValidModelName(name)) throw new StorageError('E_NAME'", "if (false as boolean) throw new StorageError('E_NAME'"),
    # browser: builds the app from the mutated source and drives real Chrome
    ("ui canvas: arrow keys do nothing", WC, "if (key && dirs[e.key]) {", "if (false as boolean) {", E2E),
    ("ui canvas: a finished drag is not recorded", WC, "if (n) this.editor.moveNode(d.key!, n.x, n.y);", "", E2E),
    ("ui canvas: drag-to-connect does nothing", WC, "if (node && target !== d.key) this.editor.connect(d.fromGate!, node.id);", "if (false as boolean) this.editor.connect(d.fromGate!, node.id);", E2E),
    ("ui properties: an out-of-range probability is accepted", WP, "if (v < 0 || v > 1) return this.refuse(", "if (false as boolean) return this.refuse(", E2E),
    ("ui shell: Ctrl+Enter does not run", WS, "} else if (mod && e.key === 'Enter') {\n      e.preventDefault();\n      if (editor.canRun) run();", "} else if (false as boolean) {\n      e.preventDefault();\n      if (editor.canRun) run();", E2E),
    ("ui shell: Escape does not cancel a run", WS, "if (editor.running) void editor.cancel();", "", E2E),
    ("ui shell: no guard against leaving with unsaved work", WS, "window.addEventListener('beforeunload', (e) => {\n    if (editor.dirty || eventTree?.dirty) {", "window.addEventListener('beforeunload', (e) => {\n    if (false as boolean) {", E2E),
    ("ui results: no stale banner", WR, "if (ed.stale) {", "if (false as boolean) {", E2E),
    ("ui results: a caveat is not shown", WR, "for (const c of rec.caveats)", "for (const c of [] as string[])", E2E),
    # lessons (plan 04): the checker, the loader, the editor's use of results, the server, and the panel
    ("lesson: completion ignores the engine result", LS, "mistakes.length === 0 && matched !== null }", "mistakes.length === 0 }"),
    ("lesson: tolerance is not capped", LS, "out.tolerance.absolute > MAX_TOLERANCE", "false as boolean"),
    ("lesson: a malformed document is credited", LS, "  if (p.malformed) return false;\n", ""),
    ("lesson: gate ids count as shared events", LS, "for (const i of new Set(g.inputs)) if (isEvent.has(i)) n.set(", "for (const i of new Set(g.inputs)) if (true as boolean) n.set("),
    ("lesson: expected probability not compared with the oracle", LS, "Math.abs(ref.expected_probability - typed.probability) > 1e-12 ||", "false as boolean ||"),
    ("lesson: a vote gate with a repeated input passes", LS, "distinct.size === topGate.inputs.length && ", ""),
    ("lesson: percent mistake never fires", LS, "e.probability > 1 && e.probability <= 100", "false as boolean"),
    ("editor: a lesson credits a stale result", WE, "if (this.result?.kind !== 'ran' || this.stale) return undefined;", "if (this.result?.kind !== 'ran') return undefined;"),
    ("editor: a lesson credits a truncated result", WE, "if (r.status !== 'completed' || r.completeness !== 'complete' || r.top_event_probability === null) return undefined;", "if (r.top_event_probability === null) return undefined;"),
    ("editor: lesson merges two nodes with the same name", WE, "if (name && counts.get(name) === 1) label.set(n.id, name);", "if (name) label.set(n.id, name);"),
    ("editor: hand calculation shown before a run", WE, "if (this.lesson && this.hasTried) {", "if (this.lesson) {"),
    ("server lessons: an invalid lesson is skipped", SL, "      throw new LessonsUnavailable(`lesson file ${f} is refused (${why})`);", "      continue;"),
    ("server: lessons served without configuration", SA, "if (!opts.lessonsDir || !opts.oraclesFile) throw new HttpError(503, 'E_LESSONS_UNAVAILABLE', 'lessons are not configured');\n      return send(res, 200, { lessons: loadLessons(", "return send(res, 200, { lessons: loadLessons("),
    ("ui lesson: hand calculation button always enabled", WL, "disabled: !ed.hasTried,", "disabled: false as boolean,", E2E),
    ("ui lesson: completion shown when only the steps are done", WL, "if (p.complete) {", "if (allSteps) {", E2E),
    # compare runs (plan 03): the pure diff, the read-only run store, the editor and the panel
    ("compare: a changed gate type is not reported", CM, "const type = g.type !== h.type ? { from: g.type, to: h.type } : null;", "const type = null;"),
    ("compare: input order counts as a difference", CM, "const inputs = !same([...g.inputs].sort(), [...h.inputs].sort())", "const inputs = !same(g.inputs, h.inputs)"),
    ("compare: a probability change is not reported", CM, "const probability = e.probability !== f.probability ?", "const probability = false as boolean ?"),
    ("compare: a name change makes the models differ", CM, "events.changed.filter((e) => e.probability).length;", "events.changed.length;"),
    ("compare: cut-set identity depends on event order", CM, "const key = (events: string[]): string => JSON.stringify([...events].sort());", "const key = (events: string[]): string => JSON.stringify(events);"),
    ("compare: a changed cut-set probability is not noticed", CM, "else if (w.probability !== v.probability) cut.changed.push(", "else if (false as boolean) cut.changed.push("),
    ("compare: a ratio is given for a zero earlier value", CM, "ratio: pa !== null && pb !== null && pa !== 0 ? pb / pa : null", "ratio: pa !== null && pb !== null ? pb / pa : null"),
    # (no mutation for the dirname check in runs.ts runDir: RUN_ID and the ".." test already refuse every path, so removing it changes nothing; it stays as defence in depth)
    ("runs: a damaged run is listed", SR, "if (!isObj(rec) || rec.schema_version !== 1) continue;", ""),
    ("runs: listing is oldest first", SR, ".sort().reverse().slice(0, limit * 2)", ".sort().slice(0, limit * 2)"),
    ("editor: a failed comparison keeps showing the old one", WE, "      this.comparison = null;\n      this.compareError = `Could not load the runs:", "      this.compareError = `Could not load the runs:"),
    ("ui compare: the choice follows new runs after the student picked", WK, "if (!this.chosen || !ids.includes(this.a) || !ids.includes(this.b)) {", "if (!ids.includes(this.a) || !ids.includes(this.b)) {", E2E),
    ("ui compare: the unexpected-difference warning is never shown", WK, "if (r.sameInputs && p.delta !== null && p.delta !== 0) {", "if (false as boolean) {", E2E),
    # SEED side (plan 11): the headless runner and the generated oracle entries
    ("headless: a truncated result is written as a result", HL, "if (outcome.status !== 'completed' || outcome.completeness !== 'complete') {", "if (outcome.status !== 'completed') {"),
    ("headless: an invalid model reaches the engine", HL, "if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(warnTyped) }, 2);\n    let engine: EngineConfig | null = null;", "let engine: EngineConfig | null = null;"),
    ("headless: model text is not labelled as app content", HL, "  source: 'app-content',\n", ""),
    ("headless: SEED's schema code is not used", HL, "code: i.code === 'E_SCHEMA' ? 'E_SCHEMA_INVALID' : i.code,", "code: i.code,"),
    ("headless: a run id with a path is accepted", HL, "if (!RUN_ID.test(runId))", "if (false as boolean)"),
    ("headless: the timeout is not bounded", HL, "if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 86400)", "if (false as boolean)"),
    ("headless: an unexpected failure leaks its text", HL, "message: 'the runner failed unexpectedly'", "message: String(e)"),
    ("seed oracle: the tolerance pin leaves out the expected value", SO, "sha256(canon({ expected, tolerance }))", "sha256(canon({ tolerance }))"),
    ("seed oracle: approximation rows are exported", SO, "x.type === 'numerical' && x.method === 'exact'", "x.type === 'numerical'"),
    ("compare: same inputs ignores the method", CM, "sameInputs: sameModel && sameMethod && sameEngine,", "sameInputs: sameModel && sameEngine,"),
    ("compare: same inputs ignores the engine build", CM, "const sameEngine = ea !== null && ea === eb && build(a) !== null && build(a) === build(b);", "const sameEngine = ea !== null && ea === eb;"),
    ("compare: hostile cut sets are accepted", CM, "return r.minimal_cut_sets.every((c) => isObj(c) && Array.isArray(c.events) && c.events.every(str) && num(c.probability));", "return true;"),
    ("compare: a record without cut sets is accepted", CM, "if (!isObj(r) || !str(r.status) || !Array.isArray(r.minimal_cut_sets)) return false;", "if (!isObj(r)) return false;"),
    ("compare: the state of each run is not reported", CM, "runs: { a: state(a), b: state(b) },", "runs: { a: { status: null, completeness: null }, b: { status: null, completeness: null } },"),
    ("headless: the active-run record is not written before the engine", HL, "writeFileSync(activeFile, activeText({ workId, workDir, pid: process.pid, state: 'running' }), { flag: 'wx' });", ""),
    ("headless: the run record may be replaced by a second run", HL, "state: 'running' }), { flag: 'wx' });", "state: 'running' }), { flag: 'w' });"),
    ("headless: cancel trusts a record that points elsewhere", HL, " || a.workDir !== expected ||", " ||"),
    ("headless: cancel claims the engine stopped without checking", HL, "nativeStopped: confirmed,", "nativeStopped: true,"),
    ("headless: an existing result folder is overwritten", HL, "for (const p of [finalDir, workRoot, flag]) {", "for (const p of [workRoot, flag]) {"),
    ("headless: the cancel flag is ignored while running", HL, "if (readFlag(flag) === workId) abort.abort();", ""),
    ("headless: any cancel request stops a run", HL, "if (readFlag(flag) === workId) abort.abort();", "if (readFlag(flag) !== null) abort.abort();"),
    ("headless: a failed process query counts as no process", HL, "probeFailed = true; // the state of the engine is not known", "probeFailed = false;"),
    ("headless: cancel confirms before the run process is gone", HL, "confirmed = !probeFailed && !owned && (retired || !deps.pidAlive(rec.pid));", "confirmed = !probeFailed && !owned;"),
    ("headless: an ended run is cancelled again", HL, "if (rec.state === 'ended') return reply(", "if (false as boolean) return reply("),
    ("headless: a link in the output folder is followed", HL, "return fail(isLink(p) ? 'E_PATH_TRAVERSAL' : 'E_EXISTS',", "return fail('E_EXISTS',"),
    ("headless: the run record is never retired", HL, "writeAtomic(activeFile, activeText({ workId, workDir, pid: process.pid, state: 'ended', status: ended }));", ""),
    ("headless: an unreadable run record means no run", HL, "if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reply(", "if (true as boolean) return reply("),
    ("engine: hasOwned never sees a live process", N, "return r.status === 0;", "return false;", PROCESS),
    ("engine: a failed process query is read as no process", N, "if (r.error || r.status === null || (r.status !== 0 && r.status !== 1)) throw new Error('the process query failed');", "", PROCESS),
    ("runs: a link inside the runs folder is followed", SR, "if (lstatSync(cur).isSymbolicLink()) throw new Error('a link');", ""),
    ("runs: a model that is not JSON is served", SR, "JSON.parse(model_text); // the model of a run is a JSON document; anything else is not served", ""),
    ("editor: a slow older comparison replaces a newer one", WE, "await Promise.all([this.api.loadRun(idA), this.api.loadRun(idB)]);\n      if (mine !== this.compareSeq) return false;", "await Promise.all([this.api.loadRun(idA), this.api.loadRun(idB)]);"),
    ("editor: clearing does not cancel a comparison in flight", WE, "this.compareSeq++; // a request still in flight must not bring the comparison back", ""),
    ("editor: a listing failure is shown as a comparison failure", WE, "this.runsError = `Could not list the saved runs: ${(e as Error).message}`;", "this.compareError = `Could not list the saved runs: ${(e as Error).message}`;"),
    ("ui compare: a listing failure is not shown", WK, "if (ed.runsError) out.push(h('div', { class: 'notice error', role: 'alert', 'data-testid': 'runs-error' }, ed.runsError));", "", E2E),
    ("ui compare: no warning for runs that are not complete", WK, "if (!solid(r.runs.a) || !solid(r.runs.b)) {", "if (false as boolean) {", E2E),
    ("headless: a staging folder that is not ours is deleted", HL, "if (stagingOwned && !(e instanceof Unsafe)) {", "if (!(e instanceof Unsafe)) {"),
    ("headless: a failed publication is recorded as completed", HL, "ended = 'failed'; // decided before any cleanup, so a cleanup error cannot leave the record saying \"completed\"", ""),
    ("headless: a staging folder swapped for a link is published", HL, "if (isLink(staging) || !isInside(outDir, staging) || [", "if (["),
    ("headless: a missing output folder is not created", HL, "mkdirSync(outDir, { recursive: true });", ""),
    # (no mutation for the non-EEXIST branch of the run-record reservation: it handles EACCES or a full disk, which a unit test cannot cause without a test seam)
    ("headless: another record in its place confirms a cancel", HL, "return r.state === 'ended' && r.workId === rec.workId && r.workDir === rec.workDir && r.pid === rec.pid;", "return r.state === 'ended';"),
    ("runs: the file read is not checked against the path afterwards", SR, "const again = plainPath(dir, ...parts); // the path must still be plain and inside the runs folder", "const again = file;"),
    ("runs: a replaced file is not noticed", SR, "if (now.ino !== st.ino || now.dev !== st.dev) throw new Error('the file was replaced while it was read');", ""),
    ("result: too many cut sets are checked anyway", Rs, "if (report.products.length > MAX_CUT_SETS) return", "if (false as boolean) return"),
    ("result: the minimality check has no budget", Rs, "if (ops > MINIMALITY_BUDGET) throw new AssessAborted('too-large');", ""),
    ("result: the minimality check never polls the deadline", Rs, "if (ops % POLL_EVERY < n) check();", ""),
    ("result: sets of the same size are compared", Rs, "const size = sets[order[at]!]!.length;", "const size = 0;"),
    ("result: a subset is not noticed", Rs, "if (c === sets[t]!.length) return true;", "if (c === sets[t]!.length + 1) return true;"),
    ("result: a timeout during the checks is reported as a result", Rs, "if (e instanceof AssessAborted) {\n      if (e.why === 'cancelled') return { ...base, status: 'cancelled', reasons: ['cancelled'] };\n      return fail(e.why === 'timeout' ? 'timeout' : 'result-too-large-to-verify');", "if (e instanceof AssessAborted) {\n      if (e.why === 'cancelled') return { ...base, status: 'cancelled', reasons: ['cancelled'] };\n      return fail('result-too-large-to-verify');"),
    ("result: a timeout at the final check is reported as too large", Rs, "if (!(e instanceof AssessAborted)) throw e;\n      if (e.why === 'cancelled') return { ...base, status: 'cancelled', reasons: ['cancelled'] };\n      return fail(e.why === 'timeout' ? 'timeout' : 'result-too-large-to-verify');", "if (!(e instanceof AssessAborted)) throw e;\n      if (e.why === 'cancelled') return { ...base, status: 'cancelled', reasons: ['cancelled'] };\n      return fail('result-too-large-to-verify');"),
    ("analyze: the time limit covers only the engine", AN, "if (now() > deadline) throw new AssessAborted('timeout');", "", TIMEOUT),
    ("result: a result is accepted without a final time check", Rs, "return accept({ ...base, ...parsed, status: 'completed', completeness: 'complete' } as ResultRecord);", "return { ...base, ...parsed, status: 'completed', completeness: 'complete' } as ResultRecord;"),
    ("result: an unread oversized report is not refused", Rs, "if (input.reportTooLarge) return fail('result-too-large-to-verify');", ""),
    ("result: the report size cap is off", Rs, "if (input.reportText.length > MAX_REPORT_BYTES) return fail('result-too-large-to-verify');", ""),
    ("result: an over-long product is indexed", Rs, "ev.length > known.size || ", ""),
    ("analyze: the engine is started with no time left", AN, "if (remaining <= 0 || opts.signal?.aborted) {", "if (false as boolean) {", TIMEOUT),
    ("bdd: nodes are not reduced", BD, "if (low === high) return low;", ""),
    ("bdd: the probability formula swaps the branches", BD, "if (n === FALSE) return 0;\n      if (n === TRUE) return 1;\n      const hit = memo.get(n);\n      if (hit !== undefined) return hit;\n      this.charge();\n      const q = p[this.v[n]!]!;\n      const r = q * go(this.hi[n]!) + (1 - q) * go(this.lo[n]!);", "if (n === FALSE) return 0;\n      if (n === TRUE) return 1;\n      const hit = memo.get(n);\n      if (hit !== undefined) return hit;\n      this.charge();\n      const q = p[this.v[n]!]!;\n      const r = (1 - q) * go(this.hi[n]!) + q * go(this.lo[n]!);"),
    ("bdd: the complement formula swaps the branches", BD, "if (n === FALSE) return 1;\n      if (n === TRUE) return 0;\n      const hit = memo.get(n);\n      if (hit !== undefined) return hit;\n      this.charge();\n      const q = p[this.v[n]!]!;\n      const r = q * go(this.hi[n]!) + (1 - q) * go(this.lo[n]!);", "if (n === FALSE) return 1;\n      if (n === TRUE) return 0;\n      const hit = memo.get(n);\n      if (hit !== undefined) return hit;\n      this.charge();\n      const q = p[this.v[n]!]!;\n      const r = (1 - q) * go(this.hi[n]!) + q * go(this.lo[n]!);"),
    ("bdd: K-of-N counts the wrong remainder", BD, "next[j] = this.or(row[j]!, this.and(fs[i]!, row[j - 1]!));", "next[j] = this.or(row[j]!, this.and(fs[i]!, row[j]!));"),
    # (no mutation for AND with FALSE or OR with TRUE: the general recursion gives the same node, only slower; and no subset test exists, see bdd.ts minimalCutSets)
    ("bdd: equal cut sets are not recognised as covered", BD, "return !lowKeys.has(s.join(','));", "return true;"),
    ("bdd: the cut-set cap is off", BD, "if (result.length > this.limits.maxCutSets) throw new SolveAborted('too-many-cut-sets');", ""),
    ("bdd: the node limit is off", BD, "if (this.v.length >= this.limits.maxNodes) throw new SolveAborted('too-many-nodes');", ""),
    ("bdd: the event cap is off", BV, "if (reachable.length > MAX_EVENTS) throw new SolveAborted('too-many-events');", ""),
    ("bdd: a K-of-N gate uses K = N", BV, "node = bdd.atLeast(g.threshold ?? ins.length, ins);", "node = bdd.atLeast(ins.length, ins);"),
    ("bdd: a cancel is ignored", BA, "if (opts.signal?.aborted) throw new AssessAborted('cancelled');", ""),
    ("bdd: the time limit is ignored", BA, "if (now() > deadline) throw new AssessAborted('timeout');", ""),
    ("bdd: the product-order limit is reported as zero", BA, "productOrderLimit: limitOrder,", "productOrderLimit: 0,"),
    ("bdd: an approximation above 1 is not clamped", BA, "probability: Math.min(1, raw),", "probability: raw,"),
    ("bdd: the rare-event sum is a product", BA, "method === 'rare-event' ? pc.reduce((a, x) => a + x, 0)", "method === 'rare-event' ? pc.reduce((a, x) => a * x, 1)"),
    ("crosscheck: a probability difference is not reported", XC, "if (!close(pa, pb)) differences.push(", "if (false as boolean) differences.push("),
    ("crosscheck: a result that is not complete is ignored", XC, "if (!solid(b)) differences.push(", "if (false as boolean) differences.push("),
    ("crosscheck: the tolerance is far too wide", XC, "const REL_TOL = 5e-5;", "const REL_TOL = 1e-1;"),
    ("crosscheck: cut sets only in the other engine are ignored", XC, "if (onlyB.length) differences.push(", "if (false as boolean) differences.push("),
    ("engine choice: the server default is SCRAM", SA, "const engine = (body.engine ?? 'builtin') as EngineChoice;\n      if (!ENGINES.includes(engine)) throw new HttpError(400, 'E_FIELD', `the engine must be one of ${ENGINES.join(', ')}`);\n      const requestId", "const engine = (body.engine ?? 'scram') as EngineChoice;\n      if (!ENGINES.includes(engine)) throw new HttpError(400, 'E_FIELD', `the engine must be one of ${ENGINES.join(', ')}`);\n      const requestId"),
    ("engine choice: an unknown engine is accepted", SA, "if (!ENGINES.includes(engine)) throw new HttpError(400, 'E_FIELD', `the engine must be one of ${ENGINES.join(', ')}`);\n      const requestId", "if (false as boolean) throw new HttpError(400, 'E_FIELD', `the engine must be one of ${ENGINES.join(', ')}`);\n      const requestId"),
    ("engine choice: no runtime still means a cross-check", SA, "if (rt.installed !== true) cross =", "if (false as boolean) cross ="),
    ("engine choice: a result of another engine stays current", WE, " || this.resultEngine !== this.engine;", ";"),
    ("engine choice: both is blocked without SCRAM", WE, "return this.engine === 'scram' && this.runtime !== null && !this.runtime.installed;", "return this.engine !== 'builtin' && this.runtime !== null && !this.runtime.installed;"),
    ("engine choice: the runner ignores --engine builtin", HL, "outcome = engine === null ? await deps.analyzeBuiltin(text, common) : await deps.analyze(text, { ...common, engine });", "outcome = await deps.analyze(text, { ...common, engine: engine! });"),
    # (no mutation for the k > n shortcut in atLeast, which gives the same FALSE by the rows; none for the parent's hard terminate after the grace period, which only matters for a solver that stops ticking: the cooperative check ends every run in the tests first)
    ("bdd: the cache budget is off", BD, "if (cached > this.limits.maxCached) throw new SolveAborted('too-much-memory');", ""),
    ("bdd: a cancel is not heard while the solver computes", BI, "const onAbort = (): void => finish(fail({ ok: false, why: 'cancelled' }));", "const onAbort = (): void => undefined;"),
    ("bdd: a worker out of memory is called an internal error", BI, "e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too-much-memory' : 'internal'", "'internal'"),
    ("bdd: the checks after the solver ignore the deadline", BA, "if (now() > deadline) throw new AssessAborted('timeout');", "if (false as boolean) throw new AssessAborted('timeout');"),
    ("bdd: MCUB loses a small probability to cancellation", BA, ": -Math.expm1(pc.reduce((a, x) => a + Math.log1p(-x), 0));", ": 1 - pc.reduce((a, x) => a * (1 - x), 1);"),
    ("result: MCUB loses a small probability to cancellation", Rs, ": -Math.expm1(pc.reduce((a, x) => a + Math.log1p(-x), 0));", ": 1 - pc.reduce((a, x) => a * (1 - x), 1);"),
    ("result: zero and a tiny probability are equal", Rs, "const close = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));", "const close = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= Math.max(1e-12, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));"),
    ("crosscheck: zero and a tiny probability agree", XC, "const close = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));", "const close = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= Math.max(1e-12, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));"),
    ("headless: the default engine is SCRAM again", HL, "defaultEngine: () => (process.env.SNEED_ENGINE === 'scram' ? 'scram' : 'builtin'),", "defaultEngine: () => 'scram',"),
    ("headless: SNEED_ENGINE is ignored", HL, "process.env.SNEED_ENGINE === 'scram' ? 'scram' : 'builtin'", "'builtin'"),
    ("headless: an explicit --engine does not win", HL, "const engineChoice = option(args, '--engine') ?? deps.defaultEngine();", "const engineChoice = deps.defaultEngine();"),
    ("bdd: the product-order limit is ignored", BA, "const kept = sol.cutSets.filter((c) => c.events.length <= limitOrder);", "const kept = sol.cutSets;"),
    # smoke checker (needs the engine)
    ("smoke: probability not compared", SM, "else if (Math.abs((r.top_event_probability ?? Number.NaN) - c.expected_probability) > Math.max(1e-12, 1e-5 * c.expected_probability)) reason = 'probability-differs';", "else if (false as boolean) reason = 'probability-differs';", SMOKE),
    ("smoke: cut sets not compared", SM, "else if (JSON.stringify(sorted(r.minimal_cut_sets.map((x) => x.events))) !== JSON.stringify(sorted(c.expected_cut_sets))) reason = 'cut-sets-differ';", "else if (false as boolean) reason = 'cut-sets-differ';", SMOKE),
    ("smoke: refused model counts as passed", SM, "out.push({ id: c.id, passed: false, reason: `refused:", "out.push({ id: c.id, passed: true, reason: `refused:", SMOKE),
]

# Importer mutations: run against the importer's own tests and the server tests.
IMPORT_SUITE = ("tests/unit/import.test.ts tests/unit/server.test.ts", 150)
IM = ROOT / "src/core/import.ts"
OFF = "if (false as boolean)"


def im(name: str, old: str, new: str, f: pathlib.Path = IM) -> tuple:
    return (f"import: {name}", f, old, new, IMPORT_SUITE)


# Three mutants were removed as equivalent (the third: a non-integer min is caught by the validator with the same code): an early existsSync(model) check is repeated by put(model) (the cleanup removes what was written), and the "written" bookkeeping mutant did not change behaviour.
MUTATIONS += [
    im("depth limit is off by one", "if (stack.length >= MAX_DEPTH)", "if (stack.length > MAX_DEPTH)"),
    im("element count limit is off by one", "++elements > MAX_ELEMENTS", "++elements > MAX_ELEMENTS + 1"),
    im("attribute value limit is off by one", "raw.length > MAX_ATTR_VALUE", "raw.length > MAX_ATTR_VALUE + 1"),
    im("attribute count limit is off by one", "el.attrs.size >= MAX_ATTRS", "el.attrs.size > MAX_ATTRS"),
    im("name length limit is gone", "if (j - i > MAX_NAME)", OFF),
    im("size limit is off by one", "> MAX_IMPORT_BYTES) return", "> MAX_IMPORT_BYTES + 1) return"),
    im("a DOCTYPE is skipped", "xmlFail(line, col, 'a DTD, DOCTYPE or entity declaration is not accepted');", "adv(input.indexOf('>', i) + 1 - i);"),
    im("a CDATA section is skipped", "xmlFail(line, col, 'a CDATA section is not accepted');", "adv(input.indexOf(']]>', i) + 3 - i);"),
    im("a processing instruction is skipped", "xmlFail(line, col, 'a processing instruction is not accepted');", "adv(2);"),
    im("an unknown entity in an attribute is accepted", "checkNoAmp(raw, raw, aLine, aCol);", "void 0;"),
    im("an unknown entity in text is accepted", "checkNoAmp(decode(text, line, col), text, line, col);", "decode(text, line, col);"),
    im("a second root element is accepted", "if (root && stack.length === 0) xmlFail(", OFF + " xmlFail("),
    im("a mismatched end tag is accepted", "if (!top || top.name !== nm) xmlFail(", "if (!top) xmlFail("),
    im("a repeated attribute is accepted", "if (el.attrs.has(an)) xmlFail(", OFF + " xmlFail("),
    im("a < in an attribute value is accepted", "if (raw.includes('<')) xmlFail(", OFF + " xmlFail("),
    im("an unclosed element is accepted", "if (stack.length) xmlFail(", OFF + " xmlFail("),
    im("text outside the root is accepted", "if (!target) xmlFail(line, col, 'text outside the root element');", "void 0;"),
    im("a forbidden character reference is accepted", "if (!(cp === 0x9 ||", "if (false && !(cp === 0x9 ||"),
    im("lines are not counted", "line++;\n        col = 1;", "col = 1;"),
    im("a comment with -- is accepted", "if (input.slice(i + 4, end).includes('--')) xmlFail(", OFF + " xmlFail("),
    im("a byte order mark is not skipped", "input.charCodeAt(0) === 0xfeff ? 1 : 0", "0"),
    im("another root element name is accepted", "if (root.name !== 'opsa-mef') {", OFF + " {"),
    im("an unknown root attribute is accepted", "if (!(a === 'version' || a === 'name' || a.startsWith('xmlns') || a.startsWith('xsi:'))) unsupported(", OFF + " unsupported("),
    im("a second fault tree is accepted", "if (trees.length > 1) unsupported(", OFF + " unsupported("),
    im("a second model-data is accepted", "if (dataBlocks.length > 1) unsupported(", OFF + " unsupported("),
    im("an unnamed fault tree is accepted", "if (treeName === undefined) err(", OFF + " err("),
    im("an unknown child of the root is ignored", "    unsupported(`<${c.name}>`, c, KNOWN_OUTSIDE.has(c.name) ? 'it has no meaning in a V1 static fault tree' : 'it is not part of the documented subset');", "    void 0;"),
    im("a gate in model-data is accepted", "else if (c.name === 'define-gate' && !dataSet.has(c)) {", "else if (c.name === 'define-gate') {"),
    im("a bad name is accepted", "if (!ID.test(nm)) {", OFF + " {"),
    im("a repeated name is accepted", "if (prior) {", OFF + " {"),
    im("a basic event without a probability is accepted", "if (kids.length === 0) err(", OFF + " err("),
    im("an expression in place of a float is accepted", "if (k.name !== 'float') {", OFF + " {"),
    im("a second float is accepted", "if (p !== null) {\n        unsupported('a second <float>'", OFF + " {\n        unsupported('a second <float>'"),
    im("a float attribute other than value is accepted", "for (const a of k.attrs.keys()) if (a !== 'value') unsupported(", "for (const a of [] as string[]) if (a !== 'value') unsupported("),
    im("any text is a number", "!FLOAT.test(raw.trim())", "Number.isNaN(Number(raw.trim()))"),
    im("zero is not a probability", "v < 0 || v > 1", "v <= 0 || v > 1"),
    im("one is not a probability", "v < 0 || v > 1", "v < 0 || v >= 1"),
    im("a probability above one is accepted", "v < 0 || v > 1", "v < 0"),
    im("a generated gate may take a defined name", "if (!defined.has(id) && !generatedIds.has(id)) {", "if (!generatedIds.has(id)) {"),
    im("a generated gate may repeat a generated name", "if (!defined.has(id) && !generatedIds.has(id)) {", "if (!defined.has(id)) {"),
    im("a reference may carry more than a name", "for (const a of el.attrs.keys()) if (a !== 'name') unsupported(`attribute ${a}`, el, `on <${el.name}>`);", "void 0;"),
    im("a reference may hold content", "if (el.children.length || el.textLine) unsupported(`content inside <${el.name}>`", OFF + " unsupported(`content inside <${el.name}>`"),
    im("a gate with no formula is accepted", "if (el.children.length !== 1) {", "if (el.children.length < 1) {"),
    im("a pass-through gate is not recorded", "aliases.set(nm, r);", "void 0;"),
    im("a pass-through loop is not noticed", "if (seen.has(r.name)) {", OFF + " {"),
    im("a basic event naming a gate is accepted", "if (r.kind === 'basic-event' && k !== 'event') err(", OFF + " err("),
    im("a gate naming a basic event is accepted", "else if (r.kind === 'gate' && k !== 'gate') err(", "else if (false as boolean) err("),
    im("the top is any unreferenced gate", "else if (unreferenced.length === 1) {", "else if (unreferenced.length >= 1) {"),
    im("a loop of gates has a top", "} else if (unreferenced.length === 0) {", "} else if (false as boolean) {"),
    im("several events with no gate have a top", "if (events.size === 1) top =", "if (events.size >= 1) top ="),
    im("validator errors are ignored", "for (const issue of v.errors) {", "for (const issue of [] as typeof v.errors) {"),
    im("the source hash is of different text", ".update(text, 'utf8')", ".update(text.trim(), 'utf8')"),
    im("notes are not ordered", "notes.sort((a, b) => a.line - b.line);", "void 0;"),
    im("errors are not capped", "if (errors.length < MAX_ERRORS) errors.push(e);", "errors.push(e);"),
    im("formula errors do not stop before resolving", "  if (errors.length) return { ok: false, errors };\n\n  // ---- resolve names", "\n  // ---- resolve names"),
    im("the model name is not bounded", ".slice(0, 200) || 'Imported model'", " || 'Imported model'"),
    im("a failed import leaves its files", "for (const f of written) {", "for (const f of [] as string[]) {", ST),
    im("an import is not size checked", "for (const t of [files.modelText, files.originalText, files.report]) {", "for (const t of [] as string[]) {", ST),
    im("a generated name loses its suffix", "const id = `${base.slice(0, 64 - suffix.length)}${suffix}`;", "const id = `${base}${suffix}`.slice(0, 64);"),
    im("a generated name may be referred to from the file", "if (gateDefs.has(id)) return 'gate';", "if (gateDefs.has(id) || generatedIds.has(id)) return 'gate';"),
    im("a loop apart from the top is not looked for", "else resolve({ name: nm, kind: 'gate', line: lineOf(nm), column: 1 });", "else void 0;"),
    im("an alias is followed whatever it was called", "if (r.kind === 'basic-event') err({ code: 'E_MISSING_REF', line: r.line, column: r.column, message: `${JSON.stringify(r.name)} is a gate", "if (false as boolean) err({ code: 'E_MISSING_REF', line: r.line, column: r.column, message: `${JSON.stringify(r.name)} is a gate"),
    im("an import overwrites an existing file", "linkSync(tmp, file);", "renameSync(tmp, file);", ST),
    im("a rollback removes files that are not ours", "      written.push(file);\n    } finally {", "    } finally {\n      written.push(file);", ST),
    im("an existing model is a bad request", "e.code === 'E_EXISTS' ? 409 : 400", "e.code === 'E_EXISTS' ? 400 : 400", SA),
    im("the import name is not checked as text", "if (typeof name !== 'string') throw new HttpError(400, 'E_FIELD', 'name must be a string');", "void 0;", SA),
    im("the original is not kept as sent", "originalText: text, report", "originalText: text.trim(), report", SA),
    im("a refusal is an error status", "return send(res, 200, { kind: 'refused', errors: result.errors });", "return send(res, 400, { kind: 'refused', errors: result.errors });", SA),
]

# Queue and saved-run reuse mutations. Three mutants were removed as equivalent (the third: the offer also compares the document text, which includes the model): a lookup of an invalid model cannot match a saved hash, and a SCRAM lookup without a runtime compares a null version with strings.
QUEUE_SUITE = ("tests/unit/server.test.ts tests/unit/web-editor.test.ts", 200)


def qm(name: str, old: str, new: str, f: pathlib.Path = SA) -> tuple:
    return (f"queue: {name}", f, old, new, QUEUE_SUITE)


MUTATIONS += [
    qm("a second press during the lookup also runs", "if (this.running || this.starting) return;", "if (this.running) return;", WE),
    qm("an offer is shown for an edited model", " && this.offer.text === this.text ? this.offer : null;", " ? this.offer : null;", WE),
    qm("showing a saved result keeps an old error", "    this.runError = null; // a failed earlier run must not hide the result being shown\n", "", WE),
    qm("lookup searches only the listed runs", "listRuns(opts.runsDir, MAX_LOOKUP_RUNS)", "listRuns(opts.runsDir)"),
    qm("the queue limit is off by one", "if (queue.length >= MAX_QUEUE)", "if (queue.length > MAX_QUEUE)"),
    qm("a finished run does not start the next", "      running = next;\n      next.start();", "      running = next;"),
    qm("a dequeued job is not marked dropped", "    job.dropped = true;\n    job.start();", "    job.start();"),
    qm("a dropped job still runs", "if (job.dropped) {", "if (false as boolean) {"),
    qm("a client that went away keeps its place", "if (!dequeue(job)) job.abort.abort();", "job.abort.abort();"),
    qm("cancel by id ignores the id", "const waiting = queue.find((j) => j.requestId === rid);", "const waiting = queue[0];"),
    qm("cancel by id of a running request does nothing", "if (running && running.requestId === rid) {", "if (false as boolean) {"),
    qm("a request id is not checked", "if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw", "if (typeof v !== 'string') throw"),
    qm("a request id may be long", "/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw", "/^[A-Za-z0-9_-]{1,640}$/.test(v)) throw"),
    qm("the status does not list the queue", "queued: queue.map((j) => ({ request_id: j.requestId }))", "queued: []"),
    qm("lookup ignores the method", "r.method === chosen && ", ""),
    qm("lookup ignores whether the run was complete", " && r.completeness === 'complete'", ""),
    qm("lookup ignores whether the run completed", "r.status === 'completed' && ", ""),
    qm("lookup ignores the engine name", " && r.engine_name === wantName", ""),
    qm("lookup ignores the engine version", " && r.engine_version === wantVersion", ""),
    qm("lookup ignores the model", "r.model_hash === hash && ", ""),
    qm("lookup reuses the cross-check", "if (engine === 'both' || !validateModelText(text).valid)", "if (!validateModelText(text).valid)"),
    qm("an unreadable saved run is offered", "return send(res, 200, none); // unreadable now: run it again", "throw new HttpError(500, 'E_INTERNAL', 'x');"),
    qm("the offer ignores the method", "return `${this.validation?.model_hash ?? ''}|${this.method}|${this.engine}`;", "return `${this.validation?.model_hash ?? ''}|${this.engine}`;", WE),
    qm("the offer ignores the engine", "return `${this.validation?.model_hash ?? ''}|${this.method}|${this.engine}`;", "return `${this.validation?.model_hash ?? ''}|${this.method}`;", WE),
    qm("Run again still offers", "if (!opts.fresh && this.engine !== 'both') {", "if (this.engine !== 'both') {", WE),
    qm("both looks for a saved run", "if (!opts.fresh && this.engine !== 'both') {", "if (!opts.fresh) {", WE),
    qm("a reused result is not marked", "    this.reused = { run_id: o.run_id, saved_at: o.saved_at };\n", "", WE),
    qm("a fresh result stays marked as reused", "        this.reused = null;\n        this.highlight = [];\n        void this.refreshRuns();", "        this.highlight = [];\n        void this.refreshRuns();", WE),
    qm("a waiting run counts the running one wrongly", "waiting + (st.running ? 1 : 0)", "waiting", WE),
    qm("cancel does not name the request", "await this.api.cancel(this.runRequestId ?? undefined)", "await this.api.cancel()", WE),
    qm("a dequeued run replaces the result", "if (r.kind === 'dequeued') this.setNotice(", "if (false as boolean) this.setNotice(", WE),
    qm("the queue poll never stops", "      clearInterval(poll);\n", "", WE),
]

# Figure (SVG/PNG/print) mutations.
FG = ROOT / "src/web/model/figure.ts"
EXPORT_SUITE = ("tests/unit/figure.test.ts tests/unit/web-editor.test.ts", 120)


def fm(name: str, old: str, new: str, f: pathlib.Path = FG) -> tuple:
    return (f"figure: {name}", f, old, new, EXPORT_SUITE)


MUTATIONS += [
    fm("an ampersand is not escaped", ".replace(/&/g, '&amp;')", ""),
    fm("a less-than is not escaped", ".replace(/</g, '&lt;')", ""),
    fm("a quote is not escaped", ".replace(/\"/g, '&quot;')", ""),
    fm("a stale result still shows numbers", "if (!r.stale) {\n    out.push(`Method:", "if (true as boolean) {\n    out.push(`Method:"),
    fm("a stale result is not announced", "if (r.stale) out.push('NO CURRENT RESULT", "if (false as boolean) out.push('NO CURRENT RESULT"),
    fm("an incomplete result is not labelled", "else if (!ok) {", "else if (false as boolean) {"),
    fm("the reasons are not listed", "for (const reason of rec.reasons) out.push(`  ${reasonText(reason)}`);", "void 0;"),
    fm("an approximation is not labelled", "rec.method === 'exact' ? '' : ' (approximation)'", "''"),
    fm("caveats are dropped", "for (const c of rec.caveats) out.push(CAVEAT_TEXT[c] ?? c);", "void 0;"),
    fm("a status other than completed passes", "const ok = rec.status === 'completed' && rec.completeness === 'complete';", "const ok = rec.completeness === 'complete';"),
    fm("a truncated completeness passes", "const ok = rec.status === 'completed' && rec.completeness === 'complete';", "const ok = rec.status === 'completed';"),
    fm("no result is not said", "if (!r) return ['No result for this drawing: the model has not been run.'];", "if (!r) return [];"),
    fm("repeated uses are not dashed", "${n.kind === 'gate' ? '' : ' stroke-dasharray=\"5 3\"'}", ""),
    fm("references are not dashed edges", "v.byKey.get(e.to)!.kind === 'reference' || v.byKey.get(e.to)!.kind === 'missing' ? ' stroke-dasharray=\"5 3\"' : ''", "''"),
    fm("the top badge is missing", "const top = isTop ?", "const top = false as boolean ?"),
    fm("events are not ellipses", "n.kind === 'event'\n      ? `<ellipse", "false as boolean\n      ? `<ellipse"),
    fm("a probability is shown with float noise", "p >= 0.001 && p < 1 ? String(Number(p.toPrecision(6)))", "p >= 0.001 && p < 1 ? String(p)"),
    fm("a tiny probability is not in exponent form", ": p.toExponential(5));", ": String(p));"),
    fm("the model hash is not given", "out.push(`Model hash ${rec.input_hashes.model_hash.slice(0, 12)}.`);", "void 0;"),
    fm("a date is always printed", "${opts.generated ? ` · ${opts.generated}` : ''}", " · 2026-01-01"),
    fm("long lines are not wrapped", ".flatMap((t) => wrapText(t, Math.floor(contentW / CHAR_W)));", ";"),
    fm("a continuation loses its indent", "out.push(cur);\n      cur = indent + w;", "out.push(cur);\n      cur = w;"),
    fm("the figure is narrower than the drawing", "const contentW = Math.max(treeW, 640);", "const contentW = 640;"),
    fm("the tree is not centred below the caption", "const ty = m + headH - v.bounds.y;", "const ty = m - v.bounds.y;"),
    fm("a file name may hold a path", ".replace(/[^A-Za-z0-9._-]+/g, '-')", ""),
    fm("a file name may be long", ".slice(0, 64);\n  return stem", ";\n  return stem"),
    fm("an empty file name stays empty", "return stem || 'fault-tree';", "return stem;"),
    fm("a disagreement is not in the figure", "else if (c.agree) out.push(", "else if (true as boolean) out.push("),
    fm("an unavailable comparison is not in the figure", "if ('unavailable' in c) out.push(", "if (false as boolean) out.push("),
    fm("XML-invalid characters stay", "t.replace(XML_INVALID, '\\uFFFD').replace(/&/g, '&amp;')", "t.replace(/&/g, '&amp;')"),
    fm("allowed characters are removed too", "\\x09\\x0A\\x0D\\x20-", "\\x20-"),
    fm("the cross-check is not passed to the figure", "...(this.result.cross ? { cross: this.result.cross } : {})", "", WE),
    fm("the figure pairs old numbers with an unchecked edit", "return this.stale || this.validatedText !== this.text;", "return this.stale;", WE),
    fm("the figure never marks a stale result", "stale: this.figureStale, ...", "stale: false, ...", WE),
]

# Publication scrub mutations. Two mutants were removed as equivalent: no spelling of a folder is a substring of another (so the longest-first order cannot matter), and an empty folder already yields no spelling longer than 3 characters.
SCR = ROOT / "src/core/scrub.ts"
SCRUB_SUITE = ("tests/unit/scrub.test.ts", 90)


def sm(name: str, old: str, new: str, f: pathlib.Path = SCR) -> tuple:
    return (f"scrub: {name}", f, old, new, SCRUB_SUITE)


MUTATIONS += [
    sm("Windows home folders are kept", "  out = out.replace(WIN_USERS, (m, a: string, n: string) => (keep(n) ? m : `${a}<user>`));\n", ""),
    sm("WSL home folders are kept", "  out = out.replace(MNT_USERS, (m, a: string, n: string) => (keep(n) ? m : `${a}<user>`));\n", ""),
    sm("macOS home folders are kept", "  out = out.replace(MAC_USERS, (m, pre: string, a: string, n: string) => (keep(n) ? m : `${pre}${a}<user>`));\n", ""),
    sm("Linux home folders are kept", "  out = out.replace(HOME, (m, pre: string, a: string, n: string) => (keep(n) ? m : `${pre}${a}<user>`));\n", ""),
    sm("an example name is replaced", "const keep = (name: string): boolean => EXAMPLE_NAMES.has(name.toLowerCase());\n  out = out.replace(WIN_USERS", "const keep = (name: string): boolean => false as boolean;\n  out = out.replace(WIN_USERS"),
    sm("account names are not removed", "if (u) out = out.replace(namePattern(u), '<user>');", "if (u) void u;"),
    sm("account names are matched inside other words", "return new RegExp(`(?<![A-Za-z0-9])${escapeRe(u).replace(/ /g, '(?: |%20)')}(?![A-Za-z0-9])`, 'gi');", "return new RegExp(escapeRe(u).replace(/ /g, '(?: |%20)'), 'gi');"),
    sm("account names are case sensitive", "(?![A-Za-z0-9])`, 'gi');", "(?![A-Za-z0-9])`, 'g');"),
    sm("an encoded name is not matched", "escapeRe(u).replace(/ /g, '(?: |%20)')", "escapeRe(u)"),
    sm("the percent-encoded folder is not replaced", "  for (const s of [...out]) out.add(s.replace(/ /g, '%20'));", "  void 0;"),
    sm("the WSL spelling of a folder is not replaced", "  if (drive) out.add(`/mnt/${drive[1]!.toLowerCase()}/${fwd.slice(3)}`); // the same folder as WSL names it", "  void drive;"),
    sm("the JSON-escaped folder is not replaced", ", fwd.replace(/\\//g, '\\\\\\\\')]);", "]);"),
    sm("the backslash folder is not replaced", "fwd.replace(/\\//g, '\\\\'), ", ""),
    sm("a folder name is used as a pattern", "new RegExp(escapeRe(s), 'gi'), placeholder", "new RegExp(s, 'gi'), placeholder"),
    sm("a folder match is case sensitive", "new RegExp(escapeRe(s), 'gi'), placeholder", "new RegExp(escapeRe(s), 'g'), placeholder"),
    sm("a system account is taken as the account", ".filter((n) => !SYSTEM_NAMES.has(n.toLowerCase()))", ""),
    sm("Windows user folders are case sensitive", "(${NAME})`, 'gi');\nconst MNT_USERS", "(${NAME})`, 'g');\nconst MNT_USERS"),
    sm("file URLs of Linux homes are missed", "|file://)(/home/)", ")(/home/)"),
    sm("a spaced name is cut at its first space", "const NAME = `(?:${NAME_SP}|${WORD})`;", "const NAME = WORD;"),
    sm("a link as the folder is followed", "  if (lstatSync(root).isSymbolicLink()) throw new Error(`${root} is a link; give the real folder (links are never followed)`);\n", "", ROOT / "scripts/scrub.ts"),
    sm("the leak check ignores home folders", "  for (const re of [WIN_USERS, MNT_USERS, MAC_USERS, HOME]) {", "  for (const re of [] as RegExp[]) {"),
    sm("the leak check ignores account names", "  for (const u of opts.usernames ?? []) {\n    if (!u) continue;", "  for (const u of [] as string[]) {\n    if (!u) continue;"),
    sm("the leak check reports example names", "      if (!keep(name)) leaks.push({ kind: 'user-folder'", "      if (true as boolean) leaks.push({ kind: 'user-folder'"),
]

# Importance measure mutations. One mutant was removed as equivalent: a second computation cannot start while one is busy, so the sequence guard on an answer never differs from true.
IMP = ROOT / "src/engines/bdd/importance.ts"
IMPORTANCE_SUITE = ("tests/unit/importance.test.ts tests/unit/server.test.ts tests/unit/web-editor.test.ts", 240)


def mi(name: str, old: str, new: str, f: pathlib.Path = IMP) -> tuple:
    return (f"importance: {name}", f, old, new, IMPORTANCE_SUITE)


MUTATIONS += [
    mi("Birnbaum cancels when the top event is almost certain", "const birnbaum = failed >= 0.5 ? worksFalse - failedFalse : failed - works;", "const birnbaum = failed - works;"),
    mi("the false side is used for a rare top event", "const birnbaum = failed >= 0.5 ? worksFalse - failedFalse : failed - works;", "const birnbaum = worksFalse - failedFalse;"),
    mi("FV is a second subtraction", "fv: top > 0 ? (q * birnbaum) / top : null,", "fv: top > 0 ? (top - works) / top : null,"),
    mi("an underflowed top is a table", "if (top === 0 && possible()) return range();", "void 0;"),
    mi("a structural zero is an error", "if (top === 0 && possible()) return range();", "if (top === 0) return range();"),
    mi("an underflowed conditional is a table", "if (works === 0 && possible({ index: i, value: 0 })) return range();", "void 0;"),
    mi("a structural infinity is an error", "if (works === 0 && possible({ index: i, value: 0 })) return range();", "if (works === 0) return range();"),
    mi("a non-finite measure is a table", "for (const x of [row.birnbaum, row.raw, row.rrw, row.fv]) if (x !== null && !Number.isFinite(x)) return range();", "void 0;"),
    mi("a zero-probability event is free", "(fixed && fixed.index === v ? fixed.value : p[v] === 0 ? 0 : p[v] === 1 ? 1 : undefined)", "(fixed && fixed.index === v ? fixed.value : undefined)"),
    mi("the editor cannot cancel a table", "await this.api.cancel(this.importanceRequestId).catch(() => undefined);", "void 0;", WE),
    mi("a cancelled table replaces the old one", "if (r.kind === 'dequeued' || (r.kind === 'failed' && r.why === 'cancelled')) this.setNotice(", "if (r.kind === 'dequeued') this.setNotice(", WE),
    mi("the failed state is not certain failure", "    p[i] = 1;\n    const failed", "    p[i] = 0.9;\n    const failed"),
    mi("the working state is not certain working", "    p[i] = 0;\n    const works", "    p[i] = 0.1;\n    const works"),
    mi("a probability is not put back", "    p[i] = q;\n", ""),
    mi("Birnbaum is only the failed side", "      probability: q,\n      birnbaum,\n", "      probability: q,\n      birnbaum: failed,\n"),
    mi("RAW divides by the wrong thing", "raw: top > 0 ? failed / top : null,", "raw: top > 0 ? failed / works : null,"),
    mi("RAW of a zero top is a number", "raw: top > 0 ? failed / top : null,", "raw: failed / top,"),
    mi("RRW of a zero denominator is infinity", "rrw: top > 0 && works > 0 ? top / works : null,", "rrw: top > 0 ? top / works : null,"),
    mi("RRW is the inverse", "rrw: top > 0 && works > 0 ? top / works : null,", "rrw: top > 0 && works > 0 ? works / top : null,"),
    mi("an infinite RRW is not flagged", "rrwInfinite: top > 0 && works === 0,", "rrwInfinite: false,"),
    mi("an infinite RRW is flagged for a zero top", "rrwInfinite: top > 0 && works === 0,", "rrwInfinite: works === 0,"),
    mi("FV is relative to the wrong thing", "fv: top > 0 ? (q * birnbaum) / top : null,", "fv: top > 0 ? (q * birnbaum) / failed : null,"),
    mi("FV of a zero top is a number", "fv: top > 0 ? (q * birnbaum) / top : null,", "fv: (q * birnbaum) / top,"),
    mi("the table is sorted smallest first", "rows.sort((a, b) => b.birnbaum - a.birnbaum ||", "rows.sort((a, b) => a.birnbaum - b.birnbaum ||"),
    mi("ties are not broken by id", " || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));", " || 0);"),
    mi("the event limit is off by one", "if (n > MAX_IMPORTANCE_EVENTS)", "if (n >= MAX_IMPORTANCE_EVENTS)"),
    mi("the event limit is gone", "if (n > MAX_IMPORTANCE_EVENTS) throw new SolveAborted('too-many-events');", ""),
    mi("the work limit is gone", "if (n * bdd.nodeCount > (opts.maxWork ?? MAX_IMPORTANCE_WORK)) throw new SolveAborted('too-many-nodes');", ""),
    mi("the work limit ignores the node count", "n * bdd.nodeCount >", "n >"),
    mi("an invalid model gets a table", "if (!validation.valid) return send(res, 200, { kind: 'refused', errors: validation.errors } satisfies ImportanceResponse);", "", SA),
    mi("names are not given", "...(names.get(r.id) ? { name: names.get(r.id)! } : {})", "", SA),
    mi("a table does not wait its turn", "      const job = await takeTurn(res, requestId);\n      if (!job) return;\n      try {\n        const answer", "      const job = { id: 0, requestId, abort: new AbortController(), dropped: false, start: () => undefined } as unknown as { id: number };\n      try {\n        const answer", SA),
    mi("a table does not give its turn back", "      } finally {\n        release(job);\n      }\n    }\n    if (p === '/api/run/lookup'", "      } finally {\n        void job;\n      }\n    }\n    if (p === '/api/run/lookup'", SA),
    mi("a failure is reported as a table", "if (!answer.ok) return send(res, 200, { kind: 'failed'", "if (false as boolean) return send(res, 200, { kind: 'failed'", SA),
    mi("a table outlives an edit", "if (!d || d.text !== this.text) return null;", "if (!d) return null;", WE),
    mi("the table can be asked for an unchecked edit", "return !this.importanceBusy && this.validation?.valid === true && this.validatedText === this.text;", "return !this.importanceBusy && this.validation?.valid === true;", WE),
    mi("a second press during the check also asks", "    this.importanceBusy = true; // before the first await, so a second press while the model is being checked is ignored\n    this.emit();\n    const mine = ++this.importanceSeq;", "    const mine = ++this.importanceSeq;", WE),
    mi("an invalid model is sent", "if (this.validation?.valid !== true) {\n      this.importanceBusy = false;", "if (false as boolean) {\n      this.importanceBusy = false;", WE),
    mi("a thrown error is shown as nothing", "this.importanceData = { text, model_hash, response: { kind: 'failed', why: 'internal', message: `Could not compute the importance table: ${(e as Error).message}` } };", "void 0;", WE),
]

# Built-in engine identity (source hash) mutations.
EID = ROOT / "scripts/lib/engine-id.ts"
EID_SUITE = ("tests/unit/engine-id.test.ts tests/unit/server.test.ts tests/unit/headless.test.ts", 150)
BA_FILE = ROOT / "src/engines/bdd/analyze.ts"


def em(name: str, old: str, new: str, f: pathlib.Path = EID) -> tuple:
    return (f"engine id: {name}", f, old, new, EID_SUITE)


MUTATIONS += [
    em("line endings change the identity", ".replace(/\\r\\n/g, '\\n')", ""),
    em("the order of the files matters", "[...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(", "[...files].map("),
    em("the path is not part of the identity", "`${f.path}\\n${sha256(normalise(f.content))}\\n`", "`${sha256(normalise(f.content))}\\n`"),
    em("the separator is missing", "`${f.path}\\n${sha256(normalise(f.content))}\\n`", "`${f.path}${sha256(normalise(f.content))}`"),
    em("the schema is not covered", "export const EXTRA_SOURCE_FILES = ['schema/model.schema.json'];", "export const EXTRA_SOURCE_FILES: string[] = [];"),
    em("only some solver files are covered", "    .filter((f) => f.endsWith('.ts'))\n    .map((f) => `src/engines/bdd/${f}`);", "    .filter((f) => f.endsWith('solve.ts'))\n    .map((f) => `src/engines/bdd/${f}`);"),
    em("the generated file hashes itself", "if (seen.has(p) || p === BUILD_ID_FILE) continue;", "if (seen.has(p)) continue;"),
    em("the file list is not sorted", "const list = files.map((f) => f.path).sort();", "const list = files.map((f) => f.path);"),
    em("imports are not followed", "      if (next) queue.push(next);", "      void next;"),
    em("type-only imports are followed", "const runtime = text.replace(/\\b(?:import|export)\\s+type\\b[^;]*?from\\s*['\"][^'\"]+['\"]/g, '');", "const runtime = text;"),
    em("a file outside the project is read", "    if (candidate.startsWith('..')) continue;\n", ""),
    em("dynamic imports are not followed", "(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)", "(?:\\bfrom\\s*|\\bimport\\s*)"),
    em("a module reached twice is read twice", "if (seen.has(p) || p === BUILD_ID_FILE) continue;", "if (p === BUILD_ID_FILE) continue;"),
    em("a record names no build", "sha256: BDD_SOURCE_SHA256, runtime: null };", "sha256: null, runtime: null };", BA_FILE),
    em("reuse ignores the build", " && r.engine_sha256 === wantSha);", ");", SA),
    em("reuse matches a record with no build", "let wantSha: string | null = BDD_SOURCE_SHA256;", "let wantSha: string | null = null;", SA),
    em("the runner does not show the build", "version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256 } },", "version: BDD_ENGINE_VERSION } },", HL),
]

# Event tree (plan 13, stage S1) mutations. One mutant was removed as equivalent: with at most 12 headings there are at most 4096 paths, so the cap inside enumeratePaths (a second guard) cannot fire. A second one was removed: the hash only reads known fields, so it cannot throw and the route's catch around it is a guard that cannot fire.
ET = ROOT / "src/core/event-tree.ts"
ETP = ROOT / "src/core/event-tree-paths.ts"
ET_SUITE = ("tests/unit/event-tree.test.ts tests/unit/server.test.ts", 200)


def tm(name: str, old: str, new: str, f: pathlib.Path = ET) -> tuple:
    return (f"event tree: {name}", f, old, new, ET_SUITE)


MUTATIONS += [
    tm("a heading with a condition is always asked", "asked = earlier !== undefined && earlier.branch === h.asked_only_if.branch;", "asked = true;", ETP),
    tm("a condition on a heading that was not asked is satisfied", "asked = earlier !== undefined && earlier.branch === h.asked_only_if.branch;", "asked = earlier === undefined || earlier.branch === h.asked_only_if.branch;", ETP),
    tm("a condition ignores the branch taken", "asked = earlier !== undefined && earlier.branch === h.asked_only_if.branch;", "asked = earlier !== undefined;", ETP),
    tm("only the works branch is walked", "    walk(i + 1, [...path, { heading: h.id, branch: 'fails' }]);\n", "", ETP),
    tm("too many headings are enumerated", "  if (headings.length > MAX_HEADINGS) return out;\n", "", ETP),
    tm("the heading limit is off by one", "export const MAX_HEADINGS = 12;", "export const MAX_HEADINGS = 13;", ETP),
    tm("the sequence limit is off by one", "export const MAX_SEQUENCES = 4096;", "export const MAX_SEQUENCES = 4097;", ETP),
    tm("no frequency is not refused as that", "if (path === '/initiating_event' && missing === 'frequency') return issue('E_NO_FREQUENCY'", "if (false as boolean) return issue('E_NO_FREQUENCY'"),
    tm("no unit is not refused as that", "if (path === '/initiating_event' && missing === 'unit') return issue('E_NO_UNIT'", "if (false as boolean) return issue('E_NO_UNIT'"),
    tm("a frequency in range is mapped wrongly", "if (path === '/initiating_event/frequency') return issue('E_FREQUENCY_RANGE'", "if (false as boolean) return issue('E_FREQUENCY_RANGE'"),
    tm("a zero frequency is not noted", "if (ie.frequency === 0) warnings.push(", "if (false as boolean) warnings.push("),
    tm("a repeated heading is accepted", "    if (headingIndex.has(h.id)) errors.push(issue('E_DUP_HEADING'", "    if (false as boolean) errors.push(issue('E_DUP_HEADING'"),
    tm("a repeated end state is accepted", "    if (endIds.has(e.id)) errors.push(issue('E_DUP_ID'", "    if (false as boolean) errors.push(issue('E_DUP_ID'"),
    tm("a condition on a later heading is accepted", "if (at === undefined || at >= i) {", "if (at === undefined) {"),
    tm("a condition on itself is accepted", "if (at === undefined || at >= i) {", "if (at === undefined || at > i) {"),
    tm("a condition on an unknown heading is accepted", "if (at === undefined || at >= i) {", "if (at >= i) {"),
    tm("the model is not looked up", "  if (ctx.resolveModel) {\n    modelChecked = true;", "  if (false as boolean) {\n    modelChecked = true;"),
    tm("a missing model is accepted", "    if (!m) errors.push(issue('E_MODEL_NOT_FOUND'", "    if (false as boolean) errors.push(issue('E_MODEL_NOT_FOUND'"),
    tm("a stale model is accepted", "      if (m.hash !== ref.model_hash) errors.push(", "      if (false as boolean) errors.push("),
    tm("an unknown heading event is accepted", "if (!m.events.has(h.event) && !m.gates.has(h.event)) errors.push(", "if (false as boolean) errors.push("),
    tm("a heading may only name a gate", "if (!m.events.has(h.event) && !m.gates.has(h.event)) errors.push(", "if (!m.gates.has(h.event)) errors.push("),
    tm("a heading may only name a basic event", "if (!m.events.has(h.event) && !m.gates.has(h.event)) errors.push(", "if (!m.events.has(h.event)) errors.push("),
    tm("sequences are not checked when a condition is wrong", "const headingsUsable = headings.length <= MAX_HEADINGS && conditionsOk && headingIndex.size === headings.length;", "const headingsUsable = headings.length <= MAX_HEADINGS;"),
    tm("an unknown heading in a path is accepted", "      if (unknown) {", "      if (false as boolean) {"),
    tm("a path that is not allowed is accepted", "      } else if (!allowed.has(key)) {", "      } else if (false as boolean) {"),
    tm("the order of the steps is not explained", "const reason = !ordered ?", "const reason = false as boolean ?"),
    tm("a repeated sequence is accepted", "      } else if (seen.has(key)) {", "      } else if (false as boolean) {"),
    tm("a missing sequence is accepted", "    if (missing.length) {", "    if (false as boolean) {"),
    tm("missing sequences are not counted", "`${missing.length} of the ${complete.length} possible path", "`${missing.length} of the ${missing.length} possible path"),
    tm("an empty end state is accepted", "    if (s.end_state === '') errors.push(", "    if (false as boolean) errors.push("),
    tm("an undefined end state is accepted", "    else if (!endIds.has(s.end_state)) errors.push(", "    else if (false as boolean) errors.push("),
    tm("an unused end state is not noted", "    if (!used.has(e.id)) warnings.push(", "    if (false as boolean) warnings.push("),
    tm("unknown fields are not noted", "for (const k of Object.keys(doc)) if (!KNOWN_TOP.includes(k)) warnings.push(", "for (const k of [] as string[]) if (!KNOWN_TOP.includes(k)) warnings.push("),
    tm("the rules run on a document with a bad structure", "  } else modelChecked = semantic(doc, ctx, errors, warnings);", "  }\n  if (isObj(doc.headings) || true) {\n    try {\n      modelChecked = semantic(doc, ctx, errors, warnings);\n    } catch {\n      /* nothing */\n    }\n  }"),
    tm("the hash includes names", "    end_states: doc.end_states.map((e) => e.id).sort(),", "    end_states: doc.end_states.map((e) => e.id + (e as { name?: string }).name).sort(),"),
    tm("the hash depends on the order of the sequences", "  for (const s of doc.sequences) ends[pathKey(s.path)] = s.end_state;", "  for (const s of doc.sequences) ends[doc.sequences.indexOf(s) + pathKey(s.path)] = s.end_state;"),
    tm("the hash ignores the end state of a sequence", "  for (const s of doc.sequences) ends[pathKey(s.path)] = s.end_state;", "  for (const s of doc.sequences) ends[pathKey(s.path)] = '';"),
    tm("the hash ignores the model it points at", "    fault_tree_model: { name: doc.fault_tree_model.name, model_hash: doc.fault_tree_model.model_hash },", "    fault_tree_model: { name: doc.fault_tree_model.name },"),
    tm("the hash ignores a condition", "...(h.asked_only_if ? { asked_only_if: { heading: h.asked_only_if.heading, branch: h.asked_only_if.branch } } : {})", ""),
    tm("a missing end state field is a generic schema error", "  if (/^\\/sequences\\/\\d+$/.test(path) && missing === 'end_state') return issue(", "  if (false as boolean) return issue("),
    tm("extra fields in schema change the hash", "schema: { id: sch.id, version: sch.version },", "schema: doc.schema,"),
    tm("extra fields in assumptions change the hash", "assumptions: { frequency_unit: as.frequency_unit, probability_basis: as.probability_basis, independence: as.independence, ie_independent_of_events: as.ie_independent_of_events, success_branches: as.success_branches },", "assumptions: doc.assumptions,"),
    tm("event trees share the model folder", "  const eventTreeDir = path.join(projectRoot, 'event-trees');", "  const eventTreeDir = projectRoot;", SA),
    tm("a tree name is not checked as a name", "      const name = safeDecode(em[1]!);\n      if (method === 'GET') {", "      const name = safeDecode(em[1]!).replace(/[.][.]/g, '');\n      if (method === 'GET') {", SA),
    tm("a missing tree is reported as a model", "throw new StorageError('E_NOT_FOUND', `no saved event tree called ${name}`);", "throw e;", SA),
    tm("a saved model is trusted without validation", "      if (!validateModelText(text).valid) return null;\n      const model = JSON.parse(text) as NativeModel;", "      const model = JSON.parse(text) as NativeModel;", SA),
    tm("a valid tree has no hash", "          tree_hash = eventTreeHash(JSON.parse(text));", "          void 0;", SA),
]

# Event tree engine (plan 13, stage S2) mutations. Removed as equivalent, each with its reason: a non-finite probability (a valid model has probabilities in 0..1, so it cannot occur); an underflowed approximation (it is at least the exact path probability, so the exact check fires first); a partition error that is not a number (the finite checks come first); the order of the compensated sum (Neumaier summation is order-insensitive in practice, the sort is a second guard); the event-count check (the diagram builder refuses first, and that line was deleted); a cancel or an expired deadline before the worker starts (the worker and the last look give the same record); a missing model taking a turn (the validator already refuses it); an end-state total that overflows (it is a part of the total frequency, which is checked, so it is finite whenever that is); a single frequency that overflows (the total of all of them is checked too, and is infinite then).
ETE = ROOT / "src/engines/bdd/event-tree.ts"
ETA = ROOT / "src/engines/bdd/event-tree-analyze.ts"
ETB = ROOT / "src/engines/bdd/bdd.ts"
ETS = ROOT / "src/engines/bdd/solve.ts"
ETE_SUITE = ("tests/unit/event-tree-engine.test.ts tests/unit/event-tree-analyze.test.ts tests/unit/server.test.ts tests/unit/bdd.test.ts", 240)


def ee(name: str, old: str, new: str, f: pathlib.Path = ETE) -> tuple:
    return (f"event tree engine: {name}", f, old, new, ETE_SUITE)


MUTATIONS += [
    ee("a forced zero takes the failed branch", "      const r = f === 0 ? go(this.lo[n]!) : f === 1 ? go(this.hi[n]!) : go(this.lo[n]!) || go(this.hi[n]!);", "      const r = f === 0 ? go(this.hi[n]!) : f === 1 ? go(this.hi[n]!) : go(this.lo[n]!) || go(this.hi[n]!);", ETB),
    ee("a forced one takes the working branch", "      const r = f === 0 ? go(this.lo[n]!) : f === 1 ? go(this.hi[n]!) : go(this.lo[n]!) || go(this.hi[n]!);", "      const r = f === 0 ? go(this.lo[n]!) : f === 1 ? go(this.lo[n]!) : go(this.lo[n]!) || go(this.hi[n]!);", ETB),
    ee("a free variable needs both branches", "      const r = f === 0 ? go(this.lo[n]!) : f === 1 ? go(this.hi[n]!) : go(this.lo[n]!) || go(this.hi[n]!);", "      const r = f === 0 ? go(this.lo[n]!) : f === 1 ? go(this.hi[n]!) : go(this.lo[n]!) && go(this.hi[n]!);", ETB),
    ee("a ratio that overflows is a table", "      if (ratio !== null && !Number.isFinite(ratio)) return range();", "      void 0;"),
    ee("an aggregate that overflows is a table", "  for (const x of [totalFrequency, approximationFrequencySum, ...endStates.flatMap((e) => [e.frequency, e.probability])]) if (x !== null && !Number.isFinite(x)) return range();", "  void 0;"),
    ee("possible is decided by a product of probabilities", "  const possible = (node: number): boolean => bdd.satisfiable(node, (v) => (p[v] === 0 ? 0 : p[v] === 1 ? 1 : undefined));", "  const possible = (node: number): boolean => bdd.probability(node, p.map((q) => (q === 0 ? 0 : q === 1 ? 1 : 0.5))) > 0;"),
    ee("a negation of false is false", "    if (a === FALSE) return TRUE;\n    if (a === TRUE) return FALSE;\n    const hit = this.notMemo", "    if (a === FALSE) return FALSE;\n    if (a === TRUE) return FALSE;\n    const hit = this.notMemo", ETB),
    ee("a negation of true is true", "    if (a === FALSE) return TRUE;\n    if (a === TRUE) return FALSE;\n    const hit = this.notMemo", "    if (a === FALSE) return TRUE;\n    if (a === TRUE) return TRUE;\n    const hit = this.notMemo", ETB),
    ee("a negation swaps nothing", "const r = this.mk(this.v[a]!, this.not(this.lo[a]!), this.not(this.hi[a]!));", "const r = this.mk(this.v[a]!, this.not(this.hi[a]!), this.not(this.lo[a]!));", ETB),
    ee("only the first root is built", "  const stack: string[] = [...roots].reverse();\n  while (stack.length) {\n    const id = stack[stack.length - 1]!;", "  const stack: string[] = [roots[0]!];\n  while (stack.length) {\n    const id = stack[stack.length - 1]!;", ETS),
    ee("a works branch is the failure event", "    workNode.set(h.id, bdd.not(f));", "    workNode.set(h.id, f);"),
    ee("a fails branch is the complement", "      cond = bdd.and(cond, step.branch === 'fails' ? f : workNode.get(step.heading)!);", "      cond = bdd.and(cond, step.branch === 'fails' ? workNode.get(step.heading)! : f);"),
    ee("a path condition is an OR", "      cond = bdd.and(cond, step.branch === 'fails' ? f : workNode.get(step.heading)!);", "      cond = bdd.or(cond === TRUE ? 0 : cond, step.branch === 'fails' ? f : workNode.get(step.heading)!);"),
    ee("the approximation counts no failure", "      if (step.branch === 'fails') failures = bdd.and(failures, f);", "      void 0;"),
    ee("the approximation counts the successes too", "      if (step.branch === 'fails') failures = bdd.and(failures, f);", "      failures = bdd.and(failures, step.branch === 'fails' ? f : workNode.get(step.heading)!);"),
    ee("the frequency is not scaled", "    const frequency = lambda * probability;", "    const frequency = probability;"),
    ee("an underflowed path is a table", "    if (probability === 0 && possible(cond)) return range();", "    void 0;"),
    ee("an impossible path is an error", "    if (probability === 0 && possible(cond)) return range();", "    if (probability === 0) return range();"),
    ee("zero and certain events are free", "bdd.satisfiable(node, (v) => (p[v] === 0 ? 0 : p[v] === 1 ? 1 : undefined))", "bdd.satisfiable(node, () => undefined)"),
    ee("a frequency that underflows is a table", "    if (!Number.isFinite(frequency) || (frequency === 0 && probability > 0 && lambda > 0)) return range();", "    if (!Number.isFinite(frequency)) return range();"),
    ee("the partition is not checked", "  if (!(partitionError <= PARTITION_TOLERANCE)) throw new SolveAborted('sequences-do-not-partition');", "  void 0;"),
    ee("the partition tolerance is loose", "export const PARTITION_TOLERANCE = 1e-9;", "export const PARTITION_TOLERANCE = 0.5;"),
    ee("the sum is not compensated", "    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;", "    c += 0;"),
    ee("end states sum probabilities as frequencies", "frequency: stableSum(list.map((x) => x.frequency)), probability:", "frequency: stableSum(list.map((x) => x.probability)), probability:"),
    ee("an end state collects every sequence", "const list = byEnd.get(e.id) ?? [];", "const list = sequences;"),
    ee("the total frequency is not scaled", "  const totalFrequency = lambda * probabilitySum;", "  const totalFrequency = probabilitySum;"),
    ee("the approximation sum is taken when not asked", "  const approximationFrequencySum = opts.approximation ? stableSum(", "  const approximationFrequencySum = true ? stableSum("),
    ee("a path naming no heading is accepted", "      if (f === undefined) throw new RangeError(`the path names ${step.heading}, which is not a heading`);", "      if (f === undefined) continue;"),
    ee("a late result is accepted", "  if (now() > deadline) return failed('failed', 'timeout'); // a last look", "  void 0; // a last look", ETA),
    ee("a failed analysis is reported as complete", "  if (!answer.ok) return answer.why === 'cancelled' ? failed('cancelled', 'cancelled') : failed('failed', answer.why);", "  if (!answer.ok) return failed('failed', 'x');", ETA),
    ee("a cancel is reported as a failure", "  if (!answer.ok) return answer.why === 'cancelled' ? failed('cancelled', 'cancelled') : failed('failed', answer.why);", "  if (!answer.ok) return failed('failed', answer.why);", ETA),
    ee("the inputs are not kept as submitted", "  writeFileSync(path.join(runDir, 'native', 'event-tree.json'), treeText, { encoding: 'utf8' }); // byte for byte as submitted", "  writeFileSync(path.join(runDir, 'native', 'event-tree.json'), JSON.stringify(JSON.parse(treeText)), { encoding: 'utf8' });", ETA),
    ee("a run folder may be reused", "  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);", "  void 0;", ETA),
    ee("a weak run id is accepted", "  if (!/^[A-Za-z0-9_-]{8,}$/.test(runId)) throw new RangeError", "  if (false as boolean) throw new RangeError", ETA),
    ee("a refused tree writes a folder", "  if (!v.valid) return { kind: 'refused', errors: v.errors, warnings: v.warnings };", "  void 0;", ETA),
    ee("an invalid model is analysed", "  if (!modelCheck.valid) return refuse(", "  if (false as boolean) return refuse(", ETA),
    ee("the ratio divides by zero", "      const ratio = probability === 0 ? null : ap / probability;", "      const ratio = ap / probability;"),
    ee("the approximation block is always there", "    approximation: c.approximationFrequencySum === null ? null : {", "    approximation: {", ETA),
    ee("the record names no engine build", "    engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256, runtime: null },", "    engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: null, runtime: null },", ETA),
    ee("the caveat about plants is dropped", "caveats: ['A frequency here is a model result under the stated assumptions, not a plant figure.', ", "caveats: [", ETA),
    ee("a non-boolean approximation flag is accepted", "      if (body.approximation !== undefined && typeof body.approximation !== 'boolean') throw new HttpError(400, 'E_FIELD', 'approximation must be true or false');", "      void 0;", SA),
    ee("an invalid tree takes a turn first", "      if (!v.valid || !loaded) return send(res, 200, { kind: 'refused', errors: v.errors, warnings: v.warnings });\n      const job = await takeTurn(res, requestId);", "      const job = await takeTurn(res, requestId);\n      if (!v.valid || !loaded) return send(res, 200, { kind: 'refused', errors: v.errors, warnings: v.warnings });", SA),
    ee("the turn is not given back", "        const out = await analyzeEventTreeBuiltin(text, loaded.text, { runsDir: opts.runsDir, signal: job.abort.signal, approximation: body.approximation === true });\n        if (out.kind === 'refused') return send(res, 200, out);\n        return send(res, 200, { kind: 'ran', run_id: path.basename(out.runDir), record: out.record });\n      } finally {\n        release(job);", "        const out = await analyzeEventTreeBuiltin(text, loaded.text, { runsDir: opts.runsDir, signal: job.abort.signal, approximation: body.approximation === true });\n        if (out.kind === 'refused') return send(res, 200, out);\n        return send(res, 200, { kind: 'ran', run_id: path.basename(out.runDir), record: out.record });\n      } finally {\n        void job;", SA),
    ee("the request is not cancellable", "        const out = await analyzeEventTreeBuiltin(text, loaded.text, { runsDir: opts.runsDir, signal: job.abort.signal,", "        const out = await analyzeEventTreeBuiltin(text, loaded.text, { runsDir: opts.runsDir,", SA),
    ee("the approximation flag is ignored", "approximation: body.approximation === true });", "approximation: false });", SA),
]

# Event tree editor (plan 13, stage S3): the document operations and the editor's state. The view itself (src/web/ui/event-tree.ts) is covered by the
# end-to-end tests and the axe audit, not by mutants here.
EDOC = ROOT / "src/web/model/event-tree-doc.ts"
EED = ROOT / "src/web/model/event-tree-editor.ts"
EUI_SUITE = ("tests/unit/web-event-tree.test.ts tests/unit/event-tree.test.ts", 120)


def eu(name: str, old: str, new: str, f: pathlib.Path = EDOC) -> tuple:
    return (f"event tree editor: {name}", f, old, new, EUI_SUITE)


MUTATIONS += [
    eu("the heading ceiling is not enforced", "  if (doc.headings.length >= MAX_HEADINGS) return doc;\n", ""),
    eu("the last heading can be removed", "  if (doc.headings.length <= 1) return doc;", "  if (doc.headings.length <= 0) return doc;"),
    eu("the last end state can be removed", "  if (doc.end_states.length <= 1) return doc;", "  if (doc.end_states.length <= 0) return doc;"),
    eu("removing a heading keeps conditions that name it", "  for (const h of next.headings) if (h.asked_only_if?.heading === id) delete h.asked_only_if;\n", ""),
    eu("moving a heading keeps a condition that now points forward", "    if (h.asked_only_if && next.headings.findIndex((x) => x.id === h.asked_only_if!.heading) >= k) delete h.asked_only_if;", "    void k;"),
    eu("a move past the end is allowed", "  if (i < 0 || j < 0 || j >= doc.headings.length) return doc;", "  if (i < 0) return doc;"),
    eu("end states are not kept for a path that still exists", "end_state: had.get(pathKey(path)) ?? '' }", "end_state: '' }"),
    eu("a new path is given an end state by a guess", "end_state: had.get(pathKey(path)) ?? '' }", "end_state: had.get(pathKey(path)) ?? previous[0]?.end_state ?? '' }"),
    eu("a new id can repeat an existing one", "  for (let i = taken.length + 1; ; i++) if (!taken.includes(`${prefix}${i}`)) return `${prefix}${i}`;", "  return `${prefix}${taken.length + 1}`;"),
    eu("removing an end state leaves sequences pointing at it", "  for (const s of next.sequences) if (s.end_state === id) s.end_state = '';\n", ""),
    eu("giving the unset an end state overwrites the chosen ones", "  for (const s of next.sequences) if (s.end_state === '') s.end_state = endState;", "  for (const s of next.sequences) s.end_state = endState;"),
    eu("an edit does not touch the updated time", "const stamp = (doc: EtDoc, now: string): EtDoc => ({ ...doc, tree: { ...doc.tree, updated: now } });", "const stamp = (doc: EtDoc, now: string): EtDoc => doc;"),
    eu("a new tree has other assumptions", "    assumptions: { ...V1_ASSUMPTIONS },", "    assumptions: {},"),
    eu("a bypass is not applied", "  if (cond) h.asked_only_if = { heading: cond.heading, branch: cond.branch };", "  if (cond) h.asked_only_if = undefined;"),
    eu("a run is allowed on text that was not checked", "    return !this.running && this.frequencyDraft === null && this.checked && this.validation!.valid;", "    return !this.running && this.frequencyDraft === null && this.validation!.valid;", EED),
    eu("an unchecked edit leaves the result looking current", "    return this.frequencyDraft !== null || !this.checked || r.input_hashes.tree_hash !== this.validation?.tree_hash || this.resultApproximation !== this.approximation;", "    return this.frequencyDraft !== null || r.input_hashes.tree_hash !== this.validation?.tree_hash || this.resultApproximation !== this.approximation;", EED),
    eu("the approximation setting does not make a result old", "    return this.frequencyDraft !== null || !this.checked || r.input_hashes.tree_hash !== this.validation?.tree_hash || this.resultApproximation !== this.approximation;", "    return this.frequencyDraft !== null || !this.checked || r.input_hashes.tree_hash !== this.validation?.tree_hash;", EED),
    eu("a changed model is not noticed", "    return this.model !== null && this.model.hash !== null && this.model.hash !== this.doc.fault_tree_model.model_hash;", "    return false;", EED),
    eu("dropped end states are not mentioned only when dropped", "(s) => s.end_state !== '' && !kept.has(pathKey(s.path))", "(s) => !kept.has(pathKey(s.path))", EED),
    eu("dropped end states are never mentioned", "    if (lost > 0) this.setNotice(", "    if (lost > 999999) this.setNotice(", EED),
    eu("a second run starts while one is in progress", "  async run(): Promise<void> {\n    if (this.running) return;", "  async run(): Promise<void> {", EED),
    eu("the run carries no request id", "await this.api.runEventTree(text, approximation, requestId);", "await this.api.runEventTree(text, approximation);", EED),
    eu("the run ignores the approximation setting", "await this.api.runEventTree(text, approximation, requestId);", "await this.api.runEventTree(text, false, requestId);", EED),
    eu("cancel carries no request id", "await this.api.cancel(this.requestId ?? undefined)", "await this.api.cancel()", EED),
    eu("the queue position forgets the run in front", "const ahead = st.running?.request_id === requestId ? 0 : waiting >= 0 ? waiting + (st.running ? 1 : 0) : 0;", "const ahead = st.running?.request_id === requestId ? 0 : waiting >= 0 ? waiting : 0;", EED),
    eu("an invalid model can be chosen", "    if (!v.valid || !v.model_hash) {", "    if (false as boolean) {", EED),
    eu("a late answer about another model is kept", "    if (mine !== this.modelSeq || name !== this.doc.fault_tree_model.name) return;", "    if (false as boolean) return;", EED),
    eu("the first saved model is not adopted by a new tree", "    const first = this.models[0];", "    const first = undefined as ModelInfo | undefined;", EED),
    eu("an error from the run is shown as a result", "      this.runError = e instanceof ApiError ? `${e.message} (${e.code})` : (e as Error).message;", "      this.runError = null;", EED),
    eu("a file that is not an event tree is opened", "!Array.isArray(doc.headings) || !Array.isArray(doc.sequences) || !doc.fault_tree_model || !doc.initiating_event", "false", EED),
    eu("a draft frequency does not make a result old", "    return this.frequencyDraft !== null || !this.checked || r.input_hashes.tree_hash !== this.validation?.tree_hash || this.resultApproximation !== this.approximation;", "    return !this.checked || r.input_hashes.tree_hash !== this.validation?.tree_hash || this.resultApproximation !== this.approximation;", EED),
    eu("a draft frequency does not block the analysis", "    if (this.frequencyDraft !== null) return 'the frequency is not a number';\n", "", EED),
    eu("a draft frequency is saved as if whole", "    if (this.frequencyDraft !== null) {\n      this.setNotice('warning', 'Not saved", "    if (false as boolean) {\n      this.setNotice('warning', 'Not saved", EED),
    eu("a draft frequency is not unsaved work", "    return this.text !== this.savedText || this.frequencyDraft !== null;", "    return this.text !== this.savedText;", EED),
    eu("a bad frequency is accepted as a number", "    if (t === '' || !Number.isFinite(n) || n < 0) {\n      this.frequencyDraft = v;", "    if (t === '' || !Number.isFinite(n)) {\n      this.frequencyDraft = v;", EED),
    eu("a save overwrites an edit made while it was under way", "        if (this.doc === started) this.doc = touched;", "        this.doc = touched;", EED),
    eu("a save marks an edit made meanwhile as saved", "        this.savedText = saved;", "        this.savedText = this.text;", EED),
    eu("a save finishing late touches another document", "      if (gen === this.docGen) {\n        // what reached", "      if (true as boolean) {\n        // what reached", EED),
    eu("a slow open replaces a later one", "      if (gen !== this.docGen) return false; // another New or Open", "      void gen; // another New or Open", EED),
    eu("a slow model choice replaces a later one", "    if (gen !== this.docGen || mine !== this.chooseSeq) return; // another document", "    void gen; // another document", EED),
    eu("a failed model check is silent", "        this.setNotice('error', `Could not read ${name}: ${(e as Error).message}`);\n        this.emit();", "        this.emit();", EED),
    eu("a failed cancel is silent", "      this.setNotice('error', `Could not cancel the analysis: ${(e as Error).message}`);", "      void e;", EED),
    eu("opening another tree keeps a half-typed frequency", "      this.frequencyDraft = null;\n      this.doc = doc;", "      this.doc = doc;", EED),
]

# Event tree drawing, saved analyses and Compare (plan 13, stage S4). The files that read and write browser downloads and the print sheet
# (src/web/ui/event-tree-export.ts) are covered by the end-to-end tests, not by mutants here. Removed because only the end-to-end test can see it: the sentence naming a damaged file in the Compare panel (e2e/event-tree-compare.spec.ts). Removed as equivalent: the existence test before a
# run folder is opened (a fault-tree folder has no such file, so reading it fails and is skipped anyway: the test only saves work).
EFIG = ROOT / "src/web/model/event-tree-figure.ts"
ECMP = ROOT / "src/core/event-tree-compare.ts"
ERUNS = ROOT / "src/server/runs.ts"
EED4 = ROOT / "src/web/model/event-tree-editor.ts"
S4_SUITE = ("tests/unit/event-tree-figure.test.ts tests/unit/event-tree-compare.test.ts tests/unit/event-tree-runs.test.ts tests/unit/web-event-tree.test.ts", 120)


def sf(name: str, old: str, new: str, f: pathlib.Path = EFIG) -> tuple:
    return (f"event tree s4: {name}", f, old, new, S4_SUITE)


MUTATIONS += [
    sf("one sequence too few is drawn at the limit", "enumeratePaths(doc.headings).length <= MAX_DRAWN_SEQUENCES;", "enumeratePaths(doc.headings).length < MAX_DRAWN_SEQUENCES;"),
    sf("the drawing limit is off by one", "export const MAX_DRAWN_SEQUENCES = 64;", "export const MAX_DRAWN_SEQUENCES = 63;"),
    sf("a heading with a condition is always asked in the drawing", "    return earlier !== undefined && earlier.branch === c.branch;\n  };", "    return true;\n  };"),
    sf("the drawing ignores the branch a condition names", "    return earlier !== undefined && earlier.branch === c.branch;\n  };", "    return earlier !== undefined;\n  };"),
    sf("an old result is drawn as current", "const cur = opts.result && !opts.result.stale && opts.result.record.status", "const cur = opts.result && opts.result.record.status"),
    sf("a result that is not complete is drawn as numbers", " && opts.result.record.completeness === 'complete' ? opts.result.record : null;", " ? opts.result.record : null;"),
    sf("an old result is not said to be old", "  if (r.stale) return ['NO CURRENT RESULT", "  if (false as boolean) return ['NO CURRENT RESULT"),
    sf("a result that is not complete is not said to be diagnostic", "if (rec.status !== 'completed' || rec.completeness !== 'complete') {", "if (rec.status !== 'completed' && rec.completeness !== 'complete') {"),
    sf("the approximation is not mentioned", "  if (rec.approximation) out.push(", "  if (false as boolean) out.push("),
    sf("the partition check is not shown", "  if (rec.total) out.push(", "  if (false as boolean) out.push("),
    sf("an example end state is not labelled", "endStateLabel(short(e.name, 30), e.synthetic)", "short(e.name, 30)"),
    sf("a missing end state is not shown as missing", "id === '' ? '(no end state)' : id;", "id === '' ? '' : id;"),
    sf("the works and fails branches are drawn the wrong way round", "const works = go(i + 1, [...path, { heading: id, branch: 'works' }]);\n    const fails = go(i + 1, [...path, { heading: id, branch: 'fails' }]);", "const fails = go(i + 1, [...path, { heading: id, branch: 'fails' }]);\n    const works = go(i + 1, [...path, { heading: id, branch: 'works' }]);"),
    sf("a sequence takes another one's frequency", "const f = freq.get(it.key);", "const f = freq.get(leaves[0]!);"),
    sf("the caveats are dropped from the figure", "  for (const c of rec.caveats) out.push(c);\n", ""),
    sf("the warnings are dropped from the figure", "  for (const w of rec.warnings) out.push(`Warning: ${w}`);\n", ""),
    sf("the file stem keeps unsafe characters", "const stem = raw.replace(/[^A-Za-z0-9._-]+/g, '-')", "const stem = raw.replace(/[^A-Za-z0-9._/-]+/g, '-')"),
    sf("numbers are compared when only one analysis is complete", "  const numbers = a.complete && b.complete && !a.malformed && !b.malformed;", "  const numbers = (a.complete || b.complete) && !a.malformed && !b.malformed;", ECMP),
    sf("a change from zero has a ratio", "ratio: from === 0 ? null : to / from }", "ratio: to / from }", ECMP),
    sf("an unchanged number is reported as changed", "const moved = (from: number, to: number): Moved | null => (from === to ? null :", "const moved = (from: number, to: number): Moved | null => (false as boolean ? null :", ECMP),
    sf("an unknown heading is named by a placeholder", ".find((n) => n !== undefined) ?? p.heading}", ".find((n) => n !== undefined) ?? '?'}", ECMP),
    sf("an unchanged sequence is not counted", "      else seqs.unchanged++;", "      else seqs.unchanged += 0;", ECMP),
    sf("a moved end state is not noticed", "const end_state = sa.end_state !== sb.end_state ? { from: sa.end_state, to: sb.end_state } : null;", "const end_state = null;", ECMP),
    sf("a sequence that only changed end state is dropped", "      if (frequency || end_state) seqs.changed.push(", "      if (frequency) seqs.changed.push(", ECMP),
    sf("the same inputs are claimed without a stated engine", "sameInputs: sameTree && sameModel && idA !== null && idA === idB,", "sameInputs: sameTree && sameModel && engineA === engineB,", ECMP),
    sf("two missing tree hashes are the same tree", "const sameTree = a.treeHash !== null && a.treeHash === b.treeHash;", "const sameTree = a.treeHash === b.treeHash;", ECMP),
    sf("two missing model hashes are the same model", "const sameModel = a.modelHash !== null && a.modelHash === b.modelHash;", "const sameModel = a.modelHash === b.modelHash;", ECMP),
    sf("a total is compared when numbers are not", "    total: numbers && a.total !== null && b.total !== null ?", "    total: a.total !== null && b.total !== null ?", ECMP),
    sf("an assumption that did not change is listed", ".filter((x) => x.from !== x.to);", ";", ECMP),
    sf("a sequence with a bad frequency is not noticed as damage", "      if (!isObj(s) || !str(s.key) || !num(s.frequency)) {\n        damaged = true;\n        continue;", "      if (!isObj(s) || !str(s.key) || !num(s.frequency)) {\n        continue;", ECMP),
    sf("an end state with a bad frequency is read", "if (isObj(e) && str(e.id) && num(e.frequency)) endStates.set(", "if (isObj(e) && str(e.id)) endStates.set(", ECMP),
    sf("a record of another kind is read", "if (!isObj(raw) || !isObj(raw.schema) || raw.schema.id !== 'sneed.event-tree-result') return null;", "if (!isObj(raw)) return null;", ECMP),
    sf("a record of another version is listed", "rec.schema.id === 'sneed.event-tree-result' && rec.schema.version === 1;", "rec.schema.id === 'sneed.event-tree-result';", ERUNS),
    sf("the event-tree list has no limit", "    if (out.length >= limit || inspected >= MAX_INSPECTED_EVENT_TREE_RUNS) break;", "    if (inspected >= MAX_INSPECTED_EVENT_TREE_RUNS) break;", ERUNS),
    sf("the event-tree list is oldest first", "const ids = readdirSync(dir).filter(isValidRunId).sort().reverse();\n  const out: EventTreeRunInfo[]", "const ids = readdirSync(dir).filter(isValidRunId).sort();\n  const out: EventTreeRunInfo[]", ERUNS),
    sf("a record of another kind is served", "    if (!isEtRecord(record)) throw new Error('not an event-tree result');\n", "", ERUNS),
    sf("a failed comparison leaves the earlier one on show", "    const mine = ++this.compareSeq;\n    this.comparison = null;\n", "    const mine = ++this.compareSeq;\n", EED4),
    sf("a late comparison replaces a later one", "      if (mine !== this.compareSeq) return; // a later choice took over while these were being read", "      void mine; // a later choice took over while these were being read", EED4),
    sf("clearing does not stop a late comparison", "  clearComparison(): void {\n    this.compareSeq++;\n", "  clearComparison(): void {\n", EED4),
    sf("a run does not refresh the list of analyses", "        this.resultPrediction = { result: r, value: predictionNow };\n        void this.refreshRuns();", "        this.resultPrediction = { result: r, value: predictionNow };", EED4),
    sf("returning to the view does not refresh the analyses", "this.loadModelInfo(), this.refreshRuns()]);", "this.loadModelInfo()]);", EED4),
    sf("an unreadable file is not named", "      this.compareError = `Could not read the saved analyses: ${(e as Error).message}`;", "      this.compareError = null;", EED4),
    sf("a file that is not a result is accepted", "      if (!diff) this.compareError = 'One of these files is not an event-tree result, so they cannot be compared.';", "      if (!diff) this.compareError = null;", EED4),
    sf("the event-tree list opens any number of files", "    if (out.length >= limit || inspected >= MAX_INSPECTED_EVENT_TREE_RUNS) break;", "    if (out.length >= limit) break;", ERUNS),
    sf("a record without a total is trusted", "(damaged || !num(total.frequency)),", "(damaged),", ECMP),
    sf("an end state row that cannot be read is not noticed as damage", "      else damaged = true;\n    }\n  }\n  const assumptions", "    }\n  }\n  const assumptions", ECMP),
    sf("a missing list of sequences is not damage", "  if (!Array.isArray(raw.sequences)) damaged = true;\n", "", ECMP),
    sf("an engine build is compared by its short label", "(idA !== idB || engineA !== engineB) ? { from: engineA, to: engineB } : null,", "(engineA !== engineB) ? { from: engineA, to: engineB } : null,", ECMP),
    sf("an invalid frequency entry is drawn as the input", "const freqText = opts.frequencyDraft != null ?", "const freqText = false ?"),
    sf("the editor does not pass the invalid entry to the figure", ", frequencyDraft: this.frequencyDraft });", " });", EED4),
    sf("a string in a saved record is not cut short", "const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);", "const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v : null);", ERUNS),
    sf("the number of files opened is not bounded in total", "    inspected++;\n", "", ERUNS),
]

# Event-tree lessons (plan 13, stage S5): the checker, the loader that refuses an unchecked lesson, the route that withholds the instructor's
# answers, and the editor's lesson state. The lesson panel itself (src/web/ui/event-tree-lesson.ts) is covered by the end-to-end tests and the axe audit.
# Removed as equivalent, each with its reason: the length of an outcome's list equal to the number of sequences analysed (the outcome keys are required to be unique, so the size of their set is the same number); the generation check of a lesson start beside the check that the document is still the one the start began with (any start, New or Open that replaces the document also changes it, so the second check alone sees the same cases).
ELC = ROOT / "src/core/event-tree-lesson.ts"
ELS = ROOT / "src/server/event-tree-lessons.ts"
ELA = ROOT / "src/server/app.ts"
ELE = ROOT / "src/web/model/event-tree-editor.ts"
S5_SUITE = ("tests/unit/event-tree-lesson.test.ts tests/unit/web-event-tree.test.ts tests/unit/event-tree-oracles.test.ts", 150)


def lm(name: str, old: str, new: str, f: pathlib.Path = ELC) -> tuple:
    return (f"event tree lesson: {name}", f, old, new, S5_SUITE)


MUTATIONS += [
    lm("any frequency is the lesson's frequency", "return p.frequency !== null && Math.abs(p.frequency - c.value) <= 1e-12;", "return p.frequency !== null;"),
    lm("more headings than asked for are accepted", "return p.heads.length === c.events.length && p.heads.every((h, i) => h.event === c.events[i]);", "return p.heads.every((h, i) => h.event === c.events[i]);"),
    lm("more sequences than asked for are accepted", "return p.seqEnds.length === c.count;", "return p.seqEnds.length >= c.count;"),
    lm("one end state too few is enough", "return p.endIds.size >= c.count;", "return p.endIds.size >= c.count - 1;"),
    lm("an end state that does not exist counts as assigned", "p.seqEnds.every((e) => e !== '' && p.endIds.has(e))", "p.seqEnds.every((e) => e !== '')"),
    lm("the bypass check ignores the branch", "on.event === c.only_if_event && h.ask!.branch === c.branch;", "on.event === c.only_if_event;"),
    lm("a prediction is always there", "      return ctx.prediction !== null;", "      return true;"),
    lm("two headings on one event are not noticed", "return new Set(p.heads.map((h) => h.event)).size < p.heads.length;", "return new Set(p.heads.map((h) => h.event)).size < p.heads.length - 1;"),
    lm("the top event as a heading is not noticed", "return p.heads.some((h) => h.event === d.event);", "return false;"),
    lm("a zero frequency is not noticed", "return p.frequency === 0;", "return p.frequency === 1;"),
    lm("the other branch of a bypass is not noticed", "on.event === d.only_if_event && h.ask!.branch !== d.expected;", "on.event === d.only_if_event && h.ask!.branch === d.expected;"),
    lm("the tolerance of an outcome is ignored", "Math.abs(g - f.frequency) <= o.tolerance.absolute;", "Math.abs(g - f.frequency) <= 1;"),
    lm("two headings on one event give a key anyway", "  if (new Set(eventOf.values()).size !== eventOf.size) return null;\n", ""),
    lm("a lesson is complete without a matching analysis", "complete: !malformed && steps.every((s) => s.done) && mistakes.length === 0 && matched !== null && modelOk && predictionOk,", "complete: !malformed && steps.every((s) => s.done) && mistakes.length === 0 && modelOk && predictionOk,"),
    lm("a lesson is complete with a mistake showing", "complete: !malformed && steps.every((s) => s.done) && mistakes.length === 0 && matched !== null && modelOk && predictionOk,", "complete: !malformed && steps.every((s) => s.done) && matched !== null && modelOk && predictionOk,"),
    lm("a lesson is complete with a step undone", "complete: !malformed && steps.every((s) => s.done) && mistakes.length === 0 && matched !== null && modelOk && predictionOk,", "complete: !malformed && mistakes.length === 0 && matched !== null && modelOk && predictionOk,"),
    lm("a heading that is not asked on a path still gets a prediction", "      if (!step) return null; // not asked on this path\n", ""),
    lm("the product is not scaled by the frequency", "const product = probs.reduce((a, b) => a * b, 1) * frequency;", "const product = probs.reduce((a, b) => a * b, 1);"),
    lm("the shortfall of the product is measured against the product", "productBelow: (asked.frequency - product) / asked.frequency,", "productBelow: (asked.frequency - product) / product,"),
    lm("an outcome with a sequence too few equals the oracle", "  if (want.size !== o.frequencies.length || new Set(o.frequencies.map((f) => f.key)).size !== o.frequencies.length) return false;", "  if (new Set(o.frequencies.map((f) => f.key)).size !== o.frequencies.length) return false;"),
    lm("a model that is not the oracle's is accepted", "if (doc.top !== ref.model.top || !sameEvents || !sameGates)", "if (false as boolean)"),
    lm("a step may ask for another frequency than the oracle's", "if (c.kind === 'frequency' && Math.abs(c.value - ref.initiating_frequency) > 1e-12)", "if (false as boolean)"),
    lm("a step may ask for other headings than the oracle's", "if (c.kind === 'heading-events' && c.events.join() !== ref.headings.map((h) => h.event).join())", "if (false as boolean)"),
    lm("a step may ask for another number of sequences", "if (c.kind === 'sequence-count' && c.count !== ref.sequences.length)", "if (false as boolean)"),
    lm("a step may ask for a bypass the oracle does not have", "if (c.kind === 'bypass' && !ref.headings.some(", "if (false as boolean && !ref.headings.some("),
    lm("a prediction may name a sequence the oracle does not have", "if (lesson.prediction && !ref.sequences.some(", "if (false as boolean && !ref.sequences.some("),
    lm("a loose tolerance is accepted in a lesson file", "o.tolerance.absolute > MAX_ET_TOLERANCE", "o.tolerance.absolute > 1"),
    lm("a lesson without instructor questions is accepted", "if (!Array.isArray(l.discussion) || !l.discussion.every(", "if (false as boolean || !l.discussion.every("),
    lm("a lesson with a model name that is not a model name is served", "if (!isValidModelName(lesson.model.name))", "if (false as boolean)", ELS),
    lm("a lesson with an invalid model is served", "      if (!v.valid) throw new EtLessonError('L_BAD_MODEL'", "      if (false as boolean) throw new EtLessonError('L_BAD_MODEL'", ELS),
    lm("a lesson that disagrees with its oracle is served", "      if (why) throw new EtLessonError(why.code, why.message);", "      void why;", ELS),
    lm("two lessons with one id are served", "if (new Set(ids).size !== ids.length)", "if (false as boolean)", ELS),
    lm("two lessons may save different models under one name", "byName.get(l.model.name) !== doc)", "false)", ELS),
    lm("the instructor's answers are sent to the browser", ".map(({ discussion: _instructorOnly, ...student }) => student) });", ".map((l) => l) });", ELA),
    lm("the prediction used is the one typed after the result", "this.resultPrediction = { result: r, value: predictionNow };", "this.resultPrediction = { result: r, value: this.prediction };", ELE),
    lm("a negative prediction is a prediction", "return t === '' || !Number.isFinite(n) || n < 0 ? null : n;", "return t === '' || !Number.isFinite(n) ? null : n;", ELE),
    lm("a lesson starts with the frequency of the answer", "      doc = E.setInitiating(doc, { frequency: 1 }, this.now());\n", "", ELE),
    lm("a lesson starts with the top event as the first heading", ".events?.[0]?.id ?? 'none';", ".events?.[0]?.id ? (lesson.model.document as { top: string }).top : 'none';", ELE),
    lm("the hand calculation is available before trying", "  get hasTried(): boolean {\n    return this.result?.kind === 'ran';", "  get hasTried(): boolean {\n    return true;", ELE),
    lm("a reveal is shown for a guess typed after the result", "if (!this.lesson?.prediction || !rec || guess === null) return null;", "if (!this.lesson?.prediction || !rec) return null;", ELE),
    lm("a new tree keeps the lesson", "    this.frequencyDraft = null;\n    this.leaveLesson();\n    this.doc = E.newEventTree(", "    this.frequencyDraft = null;\n    this.doc = E.newEventTree(", ELE),
    lm("opening a tree keeps the lesson", "      this.frequencyDraft = null;\n      this.leaveLesson();\n      this.doc = doc;", "      this.frequencyDraft = null;\n      this.doc = doc;", ELE),
    lm("a lesson start throws away an edit made meanwhile", "      if (gen !== this.docGen || this.doc !== before) return false;", "      if (gen !== this.docGen) return false;", ELE),
    lm("an unrelated model completes the lesson", "const modelOk = !!ctx.modelHash && record?.input_hashes?.model_hash === ctx.modelHash;", "const modelOk = true;"),
    lm("a lesson that asks for a prediction needs none to complete", "const predictionOk = !lesson.prediction || (ctx.predictionAtResult !== undefined && ctx.predictionAtResult !== null);", "const predictionOk = true;"),
    lm("a model hash that is missing completes the lesson", "const modelOk = !!ctx.modelHash && record?.input_hashes?.model_hash === ctx.modelHash;", "const modelOk = !ctx.modelHash || record?.input_hashes?.model_hash === ctx.modelHash;"),
    lm("a mismatched model is not named", "modelMismatch: record !== null && !modelOk,", "modelMismatch: false,"),
    lm("the end states of one failure count may differ", "return states.every((g) => g.size === 1) && new Set(states.map((g) => [...g][0])).size === states.length;", "return new Set(states.map((g) => [...g][0])).size === states.length;"),
    lm("two failure counts may share an end state", "return states.every((g) => g.size === 1) && new Set(states.map((g) => [...g][0])).size === states.length;", "return states.every((g) => g.size === 1);"),
    lm("a prediction about a sequence that works is accepted", "p.sequence.length < 2 || !p.sequence.every((s) => isObj(s) && str(s.event) && s.branch === 'fails'))", "p.sequence.length < 2 || !p.sequence.every((s) => isObj(s) && str(s.event) && branch(s.branch)))"),
    lm("an outcome that names a sequence twice is accepted", "    if (new Set(listed.map((f) => f.key)).size !== listed.length) bad('outcome frequencies name a sequence twice');", "    void listed;"),
    lm("a saved model of the same name is overwritten", "        if (same(existing)) return { name, write: false };\n", "        if (same(existing)) return { name, write: false };\n        if (i === 1) return { name, write: true };\n", ELE),
    lm("only one numbered name is tried", "    for (let i = 1; i <= 20; i++) {\n      const name = i === 1 ? base : `${base}-${i}`;", "    for (let i = 1; i <= 2; i++) {\n      const name = i === 1 ? base : `${base}-${i}`;", ELE),
    lm("an analysis for another document is shown", "      else if (gen === this.docGen) {\n        this.result = r;", "      else if (true as boolean) {\n        this.result = r;", ELE),
]

# Undo and redo in the event-tree view, and the event-tree verbs of the headless runner. The shortcuts and the buttons (src/web/ui/event-tree.ts,
# shell.ts) are covered by the end-to-end tests, not by mutants here. Removed as equivalent in a test: the regular-file check of an input (a folder fails to open or to read, so it is refused as unreadable either way; the check exists for devices and pipes that would block, which a test cannot make). Duplicated blocks of the event-tree run (the same text as the fault-tree run
# in the same file) cannot be mutated one by one: the tests exercise both.
UEED = ROOT / "src/web/model/event-tree-editor.ts"
HL = ROOT / "src/cli/headless.ts"
UNDO_SUITE = ("tests/unit/web-event-tree.test.ts", 150)
HL_SUITE = ("tests/unit/headless-event-tree.test.ts tests/unit/headless.test.ts", 200)


def um(name: str, old: str, new: str) -> tuple:
    return (f"event tree undo: {name}", UEED, old, new, UNDO_SUITE)


def hv(name: str, old: str, new: str) -> tuple:
    return (f"event tree headless: {name}", HL, old, new, HL_SUITE)


MUTATIONS += [
    um("the history has no end", "    if (this.undoStack.length > EventTreeEditor.HISTORY) this.undoStack.shift();\n", ""),
    um("the history is one step short", "static readonly HISTORY = 200;", "static readonly HISTORY = 199;"),
    um("a new edit keeps what could be redone", "    this.redoStack = [];\n    this.doc = next;", "    this.doc = next;"),
    um("an edit that changes nothing is a step", "this.text) return;\n    this.undoStack.push", "this.text) void 0;\n    this.undoStack.push"),
    um("undo cannot be redone", "    this.redoStack.push({ doc: this.doc, label: step.label });\n", ""),
    um("redo cannot be undone", "    this.undoStack.push({ doc: this.doc, label: step.label });\n    this.restore(step.doc, `Redid:", "    this.restore(step.doc, `Redid:"),
    um("a frequency that is not a number is not undone first", "    if (this.frequencyDraft !== null) {\n      this.frequencyDraft = null;\n      this.revision++;", "    if (false as boolean) {\n      this.frequencyDraft = null;\n      this.revision++;"),
    um("a draft alone is nothing to undo", "return this.undoStack.length > 0 || this.frequencyDraft !== null;", "return this.undoStack.length > 0;"),
    um("a draft is not named", "return this.frequencyDraft !== null ? 'the frequency being typed' : (this.undoStack.at(-1)?.label ?? null);", "return this.undoStack.at(-1)?.label ?? null;"),
    um("an undone edit leaves the draft", "    this.revision++;\n    this.frequencyDraft = null;\n    this.scheduleValidation();", "    this.revision++;\n    this.scheduleValidation();"),
    um("an undone choice of model keeps the other model's events", " void this.loadModelInfo(); // the model the headings name may have changed", " undefined; // the model the headings name may have changed"),
    um("a new tree keeps the history", "    this.doc = E.newEventTree(ref, undefined, this.now());\n    this.resetHistory();", "    this.doc = E.newEventTree(ref, undefined, this.now());"),
    um("an opened tree keeps the history", "      this.doc = doc;\n      this.resetHistory();\n      this.fileName = name;", "      this.doc = doc;\n      this.fileName = name;"),
    um("a lesson keeps the history", "      this.doc = doc;\n      this.resetHistory();\n      this.fileName = null;", "      this.doc = doc;\n      this.fileName = null;"),
    um("an edit does not move the revision", "    this.doc = next;\n    this.revision++;", "    this.doc = next;"),
    um("an undo does not move the revision", "    this.doc = doc;\n    this.revision++;\n    this.frequencyDraft = null;", "    this.doc = doc;\n    this.frequencyDraft = null;"),
    um("an undo is not announced", "    this.restore(step.doc, `Undid: ${step.label}.`);", "    this.restore(step.doc, '');"),
    um("a heading removal is not named", "'removing a heading');", "'x');"),
    um("the choice of a model is not named", "'choosing the fault-tree model');", "'x');"),
    hv("a file over the limit is read", "    if (tooBig) return fail(", "    if (false as boolean) return fail("),
    hv("an invalid model is not refused", "    if (!mv.valid) return reply({ ok: false, errors: mv.errors.map(", "    if (false as boolean) return reply({ ok: false, errors: mv.errors.map("),
    hv("the fields of a model problem are not named under model", "typed({ ...e, path: `model${e.path === '/' ? '' : e.path}` })", "typed(e)"),
    hv("a tree is checked against no model", "resolveModel: (n) => (n === named ? ref : null) });\n    if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed)", "resolveModel: () => null });\n    if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed)"),
    hv("the limits are swapped", "limits: { headings: MAX_HEADINGS, sequences: MAX_SEQUENCES },", "limits: { headings: MAX_SEQUENCES, sequences: MAX_HEADINGS },"),
    hv("a refused tree is refused only after the record exists", "    checkEventTree(tree.text, model.text); // refused (exit 2) before any folder or record exists\n", ""),
    hv("the approximation is never asked for", "const approximation = args.includes('--approximation');", "const approximation = false;"),
    hv("the analysis cannot be cancelled", "timeoutMs: timeoutSeconds * 1000, signal, approximation });", "timeoutMs: timeoutSeconds * 1000, approximation });"),
    hv("the time limit is not passed on", "timeoutMs: timeoutSeconds * 1000, signal, approximation });", "signal, approximation });"),
    hv("a refusal of the analysis loses its errors", "errors: outcome.errors.map(typed), warnings: outcome.warnings.map(typed) };", "errors: [], warnings: [] };"),
    hv("the tree is not kept as it was", "'event-tree.json': tree.bytes,", "'event-tree.json': Buffer.from(JSON.stringify(JSON.parse(tree.text))),"),
    hv("the manifest says the approximation was not asked for", "approximation: rec.approximation !== null,", "approximation: false,"),
    hv("the manifest names the model hash as the tree hash", "          treeHash: rec.input_hashes.tree_hash,", "          treeHash: rec.input_hashes.model_hash,"),
    hv("the manifest does not hash the tree file", "treeSha256: sha256(tree.bytes),", "treeSha256: sha256(model.bytes),"),
    hv("the event-tree verbs do not exist", "    else if (verb === 'run-event-tree') await runEventTree(args);\n", ""),
    hv("describe-event-trees is missing", "    else if (verb === 'describe-event-trees') describeEventTrees();\n", ""),
    hv("validate-event-tree is missing", "    else if (verb === 'validate-event-tree') validateEventTreeVerb(args);\n", ""),
    hv("the engine build is not named", "engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256, runtime: null },\n        limits:", "engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: null, runtime: null },\n        limits:"),
    um("a value written again is an edit", "E.serialize({ ...next, tree: { ...next.tree, updated: this.doc.tree.updated } }) === this.text) return;", "E.serialize(next) === this.text) return;"),
    um("an undone choice of model keeps the other model", "    if (this.model && this.model.name !== doc.fault_tree_model.name) this.model = null;\n", ""),
    hv("a file exactly at the limit is refused", "if (st.size > MAX_INPUT_BYTES) tooBig = true;", "if (st.size >= MAX_INPUT_BYTES) tooBig = true;"),
    ("event tree headless: a gate with many inputs is re-filtered for each of them", ROOT / "src/core/validate.ts", "        childCache.set(top.id, children);\n", "", ("tests/unit/validate.test.ts", 150)),
]

THC = ROOT / "src/core/th-criterion.ts"
THS = ROOT / "schema/th-criterion.schema.json"
THA = ROOT / "schema/th-answer.schema.json"
T0_SUITE = ("tests/unit/th-criterion.test.ts", 60)


def tz(name: str, old: str, new: str, f: pathlib.Path = THC) -> tuple:
    return (f"th criterion: {name}", f, old, new, T0_SUITE)


MUTATIONS += [
    tz("above accepts equal", "return value > k.limit;", "return value >= k.limit;"),
    tz("at-least refuses equal", "return value >= k.limit;", "return value > k.limit;"),
    tz("below accepts equal", "return value < k.limit;", "return value <= k.limit;"),
    tz("at-most refuses equal", "      return value <= k.limit;", "      return value < k.limit;"),
    tz("throughout above reads the highest value", "(k.holds === 'throughout' ? o.min : o.max)", "(k.holds === 'throughout' ? o.max : o.min)"),
    tz("throughout below reads the lowest value", "k.holds === 'throughout' ? o.max : o.min;", "k.holds === 'throughout' ? o.min : o.max;"),
    tz("a held answer reads as not held", "make(holds(c, a.observed!) ? 'held' : 'did-not-hold', [])", "make(holds(c, a.observed!) ? 'did-not-hold' : 'held', [])"),
    tz("a changed tree is not stale", "  if (c.applies_to.event_tree.tree_hash !== cur.treeHash) r.push('tree-changed');\n", ""),
    tz("a changed plant is not stale", "c.plant.model_hash !== cur.plantModelHash || a.plant.model_hash !== c.plant.model_hash", "a.plant.model_hash !== c.plant.model_hash"),
    tz("an answer from another plant is not stale", "c.plant.model_hash !== cur.plantModelHash || a.plant.model_hash !== c.plant.model_hash", "c.plant.model_hash !== cur.plantModelHash"),
    tz("changed plant changes are not stale", "c.plant.mutation_list_hash !== cur.mutationListHash || a.plant.mutation_list_hash !== c.plant.mutation_list_hash", "a.plant.mutation_list_hash !== c.plant.mutation_list_hash"),
    tz("an answer from other plant changes is not stale", "c.plant.mutation_list_hash !== cur.mutationListHash || a.plant.mutation_list_hash !== c.plant.mutation_list_hash", "c.plant.mutation_list_hash !== cur.mutationListHash"),
    tz("an edited criterion leaves the answer current", "  if (a.criterion_hash !== criterionHash(c)) r.push('criterion-changed');\n", ""),
    tz("a stale answer is still read", "  if (s.length) return make('stale', s);\n", ""),
    tz("a run that does not settle the condition is read", "  if (u.length) return make('not-determined', u);\n", ""),
    tz("a failed run is not noticed", "if (a.run.status === 'failed') r.push('run-failed');", "if (false as boolean) r.push('run-failed');"),
    tz("a truncated run is not noticed", "else if (a.run.status === 'truncated') r.push('run-truncated');", "else if (false as boolean) r.push('run-truncated');"),
    tz("a run ended by a trip is not noticed", "else if (a.run.status === 'terminated-by-trip') r.push('run-terminated-by-trip');", "else if (false as boolean) r.push('run-terminated-by-trip');"),
    tz("another quantity is accepted", "if (o.quantity !== c.condition.quantity) r.push('quantity-differs');", ""),
    tz("another unit is accepted", "if (o.unit !== c.condition.unit) r.push('unit-differs');", ""),
    tz("a window that starts later is accepted", "if (o.window.from !== c.condition.window.from || o.window.to !== c.condition.window.to)", "if (o.window.to !== c.condition.window.to)"),
    tz("a window that ends sooner or later is accepted", "if (o.window.from !== c.condition.window.from || o.window.to !== c.condition.window.to)", "if (o.window.from !== c.condition.window.from)"),
    tz("a longer window is accepted", "if (o.window.from !== c.condition.window.from || o.window.to !== c.condition.window.to)", "if (o.window.from > c.condition.window.from || o.window.to < c.condition.window.to)"),
    tz("an invalid pair is read when only one is invalid", "if (!cv.valid || !av.valid) return make(", "if (!cv.valid && !av.valid) return make("),
    tz("the note that it is no probability is left out", "string => `${STATUS_TEXT[status]} ${TH_NOTE}`;", "string => STATUS_TEXT[status];"),
    tz("a completed run without observations is valid", "if (d.run.status === 'completed') errors.push(", "if (false as boolean) errors.push("),
    tz("a smallest value above the largest is valid", "if (o.min > o.max)", "if (false as boolean)"),
    tz("a flat line is refused", "if (o.min > o.max)", "if (o.min >= o.max)"),
    tz("an empty criterion window is valid", "if (!(d.condition.window.to > d.condition.window.from)) {", "if (!(d.condition.window.to >= d.condition.window.from)) {"),
    tz("a backwards criterion window is valid", "if (!(d.condition.window.to > d.condition.window.from)) {", "if (false as boolean) {"),
    tz("a backwards observed window is valid", "if (!(o.window.to > o.window.from))", "if (false as boolean)"),
    tz("a changed tree is not noticed by the criterion check", "if (tree.hash !== ref.tree_hash) errors.push(", "if (false as boolean) errors.push("),
    tz("an unknown heading is not noticed", "if (!tree.headings.has(d.applies_to.heading)) errors.push(", "if (false as boolean) errors.push("),
    tz("an unknown tree is not noticed", "if (!tree) errors.push(err('E_NO_TREE'", "if (false as boolean) errors.push(err('E_NO_TREE'"),
    tz("the tree is looked up under another name", "const tree = ctx.resolveTree(ref.name);", "const tree = ctx.resolveTree(d.criterion.name);"),
    tz("the hash ignores the heading", "heading: d.applies_to.heading },", "},"),
    tz("the hash ignores the tree", "tree_hash: d.applies_to.event_tree.tree_hash }", "}"),
    tz("the hash ignores the plant model", "model_hash: d.plant.model_hash, mutation_list_hash", "mutation_list_hash"),
    tz("the hash ignores the change list", ", mutation_list_hash: d.plant.mutation_list_hash },", " },"),
    tz("the hash ignores the limit", "comparison: c.comparison, limit: c.limit, unit", "comparison: c.comparison, unit"),
    tz("the hash ignores the comparison", "quantity: c.quantity, comparison: c.comparison, limit", "quantity: c.quantity, limit"),
    tz("the hash ignores the unit", "limit: c.limit, unit: c.unit, window", "limit: c.limit, window"),
    tz("the hash ignores the start of the window", "window: { from: c.window.from, to: c.window.to, unit: c.window.unit }", "window: { to: c.window.to, unit: c.window.unit }"),
    tz("the hash ignores the 'throughout or at some time'", ", holds: c.holds },", " },"),
    tz("the hash follows the name", "    schema: { id: d.schema.id, version: d.schema.version },\n    applies_to", "    schema: { id: d.schema.id, version: d.schema.version },\n    name: d.criterion.name,\n    applies_to"),
    tz("a heading with no criterion gets none and no refusal", "if (valid.length === 0) return { ok: false, code: 'E_TH_NO_CRITERION'", "if (valid.length === 0) return { ok: true, criterion: undefined as never, code: 'E_TH_NO_CRITERION'"),
    tz("two criteria for one heading are not refused", "if (valid.length > 1) return", "if (valid.length > 2) return"),
    tz("an invalid criterion counts as one", "if (!validateCriterion(raw).valid) {", "if (false as boolean) {"),
    tz("a criterion of another tree is found", "c.applies_to.event_tree.name === treeName && c.applies_to.heading === headingId", "c.applies_to.heading === headingId"),
    tz("a criterion of another heading is found", "c.applies_to.event_tree.name === treeName && c.applies_to.heading === headingId", "c.applies_to.event_tree.name === treeName"),
    tz("the number of skipped documents is not said", "const skip = skipped ?", "const skip = false ?"),
    tz("a changed engine name is not stale", "if (a.engine.name !== cur.engine.name || a.engine.version", "if (a.engine.version"),
    tz("a changed engine version is not stale", "a.engine.version !== cur.engine.version || a.engine.build", "a.engine.build"),
    tz("a changed engine build is not stale", "a.engine.version !== cur.engine.version || a.engine.build !== cur.engine.build) r.push('engine-changed')", "a.engine.version !== cur.engine.version) r.push('engine-changed')"),
    tz("a heading the tree lacks is not noticed", "if (!cur.treeHeadings.has(c.applies_to.heading)) r.push('heading-unknown');", ""),
    tz("an engine may be named without its build", '"required": ["name", "version", "build"],', '"required": ["name", "version"],', THA),
    tz("an engine build may be empty", '"build": { "type": "string", "minLength": 1, "maxLength": 200 }', '"build": { "type": "string", "maxLength": 200 }', THA),
    tz("a criterion may lack the plant", '"required": ["schema", "criterion", "applies_to", "plant", "condition"],', '"required": ["schema", "criterion", "applies_to", "condition"],', THS),
    tz("a criterion may name any comparison", '"comparison": { "enum": ["above", "at-least", "below", "at-most"] },', '"comparison": { "type": "string" },', THS),
    tz("a criterion may use minutes", '"unit": { "const": "s" } }\n        },\n        "holds"', '"unit": { "type": "string" } }\n        },\n        "holds"', THS),
    tz("an answer may lack its observations", '"required": ["schema", "answer", "criterion_hash", "plant", "engine", "run", "observed"],', '"required": ["schema", "answer", "criterion_hash", "plant", "engine", "run"],', THA),
    tz("an answer may come from anything", '"entered_by": { "const": "hand" },', '"entered_by": { "type": "string" },', THA),
    tz("an answer may have any run status", '"properties": { "status": { "enum": ["completed", "failed", "truncated", "terminated-by-trip"] } }', '"properties": { "status": { "type": "string" } }', THA),
]


THM = ROOT / "src/core/th-mutation.ts"
THMS = ROOT / "schema/th-mutation.schema.json"
T1_SUITE = ("tests/unit/th-mutation.test.ts", 60)


def tx(name: str, old: str, new: str, f: pathlib.Path = THM) -> tuple:
    return (f"th mutation: {name}", f, old, new, T1_SUITE)


MUTATIONS += [
    tx("a record whose models are identical is valid", "if (d.base_model.hash === d.mutated_model.hash) errors.push(", "if (false as boolean) errors.push("),
    tx("a record whose models share a name is valid", "if (d.base_model.name === d.mutated_model.name) errors.push(", "if (false as boolean) errors.push("),
    tx("an edit that changes nothing is valid", "if (e.from === e.to) errors.push(", "if (false as boolean) errors.push("),
    tx("a value is compared loosely", "if (e.from === e.to) errors.push(", "if (e.from == e.to) errors.push("),
    tx("a field edited twice is valid", "    if (seen.has(key)) errors.push(", "    if (false as boolean) errors.push("),
    tx("the duplicate key joins the names", "const key = canon([e.component, e.field]);", "const key = e.component + '.' + e.field;"),
    tx("the duplicate key ignores the component", "const key = canon([e.component, e.field]);", "const key = canon([e.field]);"),
    tx("the duplicate key ignores the field", "const key = canon([e.component, e.field]);", "const key = canon([e.component]);"),
    tx("a missing base model is not noticed", "if (!base) errors.push(", "if (false as boolean) errors.push("),
    tx("a changed base model is not noticed", "else if (base.hash !== d.base_model.hash) errors.push(", "else if (false as boolean) errors.push("),
    tx("a missing mutated model is not noticed", "if (!mut) errors.push(", "if (false as boolean) errors.push("),
    tx("a changed mutated model is not noticed", "else if (mut.hash !== d.mutated_model.hash) errors.push(", "else if (false as boolean) errors.push("),
    tx("the base model is looked up under the mutated name", "const base = ctx.resolveModel(d.base_model.name);", "const base = ctx.resolveModel(d.mutated_model.name);"),
    tx("the mutated model is looked up under the base name", "const mut = ctx.resolveModel(d.mutated_model.name);", "const mut = ctx.resolveModel(d.base_model.name);"),
    tx("the hash ignores the base model name", "base_model: { name: d.base_model.name, hash: d.base_model.hash },", "base_model: { hash: d.base_model.hash },"),
    tx("the hash ignores the base model hash", "base_model: { name: d.base_model.name, hash: d.base_model.hash },", "base_model: { name: d.base_model.name },"),
    tx("the hash ignores the mutated model name", "mutated_model: { name: d.mutated_model.name, hash: d.mutated_model.hash },", "mutated_model: { hash: d.mutated_model.hash },"),
    tx("the hash ignores the mutated model hash", "mutated_model: { name: d.mutated_model.name, hash: d.mutated_model.hash },", "mutated_model: { name: d.mutated_model.name },"),
    tx("the hash ignores the edits", "    edits,\n    applies: d.applies,", "    applies: d.applies,"),
    tx("the hash ignores when the edits apply", "    edits,\n    applies: d.applies,", "    edits,"),
    tx("the hash ignores the old value", ".map((e) => ({ component: e.component, field: e.field, from: e.from, to: e.to }))", ".map((e) => ({ component: e.component, field: e.field, to: e.to }))"),
    tx("the hash ignores the new value", ".map((e) => ({ component: e.component, field: e.field, from: e.from, to: e.to }))", ".map((e) => ({ component: e.component, field: e.field, from: e.from }))"),
    tx("the hash ignores the component", ".map((e) => ({ component: e.component, field: e.field, from: e.from, to: e.to }))", ".map((e) => ({ field: e.field, from: e.from, to: e.to }))"),
    tx("the hash follows the order of the edits", "    .sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0));", "    ;"),
    tx("the hash orders edits by component only", "a.component > b.component ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0)", "a.component > b.component ? 1 : 0)"),
    tx("an invalid record is current", "  if (!validateMutation(mutation, ctx).valid) return MUTATION_NOT_CURRENT;\n", ""),
    tx("the current record is checked against no models", "if (!validateMutation(mutation, ctx).valid) return", "if (!validateMutation(mutation).valid) return"),
    tx("an invalid record can be linked", "  if (!v.valid) return { valid: false, errors: [err('E_LINK_INVALID'", "  if (false as boolean) return { valid: false, errors: [err('E_LINK_INVALID'"),
    tx("a criterion that pins another record is linked", "if (criterion.plant.mutation_list_hash !== mutationHash(m)) errors.push(", "if (false as boolean) errors.push("),
    tx("a criterion that runs another model name is linked", "if (criterion.plant.model_name !== m.mutated_model.name || criterion.plant.model_hash !== m.mutated_model.hash) {", "if (criterion.plant.model_hash !== m.mutated_model.hash) {"),
    tx("a criterion that runs another model hash is linked", "if (criterion.plant.model_name !== m.mutated_model.name || criterion.plant.model_hash !== m.mutated_model.hash) {", "if (criterion.plant.model_name !== m.mutated_model.name) {"),
    tx("a criterion and record that do not belong together are read", "  if (!hasRecord || checkCriterionMutation(c, mutation).valid) return j;", "  if (true as boolean) return j;"),
    tx("a record that is supplied is not looked at", "  if (!hasRecord || checkCriterionMutation(c, mutation).valid) return j;", "  if (!hasRecord) return j;"),
    tx("a stale answer goes through the link check", "if (j.status === 'stale' || j.reasons.includes('criterion-invalid')) return j;", "if (j.reasons.includes('criterion-invalid')) return j;"),
    tx("an invalid criterion goes through the link check", "if (j.status === 'stale' || j.reasons.includes('criterion-invalid')) return j;", "if (j.status === 'stale') return j;"),
    tx("the other reasons are dropped beside the link reason", "const reasons = [...(j.status === 'not-determined' ? j.reasons : []), 'mutation-link-invalid' as const];", "const reasons = ['mutation-link-invalid' as const];"),
    tx("the record's current hash is not passed to the judgement", "const listHash = mutation === null || mutation === undefined ? null : currentMutationHash(mutation, models);", "const listHash = null;"),
    tx("an unlinked answer is shown as read", "return { status: 'not-determined', reasons, text: describeStatus('not-determined') };", "return { status: j.status, reasons, text: j.text };"),
    tx("a record may have no edits", '"minItems": 1,', '"minItems": 0,', THMS),
    tx("a record may have any number of edits", '"maxItems": 50,', '"maxItems": 5000,', THMS),
    tx("a record may apply at any time", '"applies": { "const": "from-start" }', '"applies": { "type": "string" }', THMS),
    tx("an edit value may be anything", '"to": { "anyOf": [{ "type": "number" }, { "type": "string", "maxLength": 200 }, { "type": "boolean" }] }', '"to": {}', THMS),
    tx("an edit text may be any length", '"to": { "anyOf": [{ "type": "number" }, { "type": "string", "maxLength": 200 }, { "type": "boolean" }] }', '"to": { "anyOf": [{ "type": "number" }, { "type": "string" }, { "type": "boolean" }] }', THMS),
    tx("a record may lack its models", '"required": ["schema", "mutation", "base_model", "mutated_model", "edits", "applies"],', '"required": ["schema", "mutation", "edits", "applies"],', THMS),
]


APP = ROOT / "src/server/app.ts"
T0R_SUITE = ("tests/unit/server-th-criteria.test.ts", 120)


def tr(name: str, old: str, new: str, f: pathlib.Path = APP) -> tuple:
    return (f"th routes: {name}", f, old, new, T0R_SUITE)


MUTATIONS += [
    tr("criteria are kept with the event trees", "const criteriaDir = path.join(projectRoot, 'th-criteria');", "const criteriaDir = path.join(projectRoot, 'event-trees');"),
    tr("the list shows the event trees", "{ criteria: listModels(criteriaDir) }", "{ criteria: listModels(eventTreeDir) }"),
    tr("a criterion is read from the event tree folder", "text: readModel(criteriaDir, name) }", "text: readModel(eventTreeDir, name) }"),
    tr("a criterion is saved in the event tree folder", "writeModel(criteriaDir, name, needText", "writeModel(eventTreeDir, name, needText"),
    tr("a missing criterion is called a model", "no saved success criterion called", "no saved model called"),
    tr("a criterion is checked against no tree", "validateCriterionText(text, { resolveTree: loadEventTree })", "validateCriterionText(text, {})"),
    tr("a tree that is not valid is found", "      if (!validateEventTreeText(text).valid) return null;\n      const doc = JSON.parse(text) as { headings", "      const doc = JSON.parse(text) as { headings"),
    tr("the tree hash is not the tree's hash", "hash: eventTreeHash(doc as Parameters<typeof eventTreeHash>[0]),", "hash: '0'.repeat(64),"),
    tr("the headings of the tree are not given", "headings: new Set(doc.headings.map((h) => h.id)) };", "headings: new Set<string>() };"),
    tr("an invalid criterion gets a hash", "      if (v.valid) {\n        try {\n          criterion_hash", "      if (true as boolean) {\n        try {\n          criterion_hash"),
    tr("a valid criterion gets no hash", "criterion_hash = criterionHash(JSON.parse(text) as ThCriterion);", "criterion_hash = null;"),
    tr("the validation does not return the document hash", "criterion_hash, document_hash: documentHash(Buffer.from(text, 'utf8')) });\n    }\n    const cm", "criterion_hash, document_hash: null });\n    }\n    const cm"),
    tr("the criterion text check leaves the tree out", "  return validateCriterion(doc, ctx);\n}\n\n/**\n * Hash of what the criterion MEANS", "  return validateCriterion(doc);\n}\n\n/**\n * Hash of what the criterion MEANS", ROOT / "src/core/th-criterion.ts"),
]


STO = ROOT / "src/server/storage.ts"
STL_SUITE = ("tests/unit/storage-links.test.ts tests/unit/storage-tmp.test.ts tests/unit/server.test.ts", 150)


def sl(name: str, old: str, new: str, f: pathlib.Path = STO) -> tuple:
    return (f"storage links: {name}", f, old, new, STL_SUITE)


# Not mutated: lstat versus stat in the list and in the file check differ only for a symbolic link to a FILE, which needs the right to make
# file symlinks (this Windows machine refuses: EPERM). tests/unit/storage-links.test.ts has that case and runs it where the right exists.
MUTATIONS += [
    sl("a linked folder is used for a name", "  plainFolder(dir);\n  plainFile(file);\n  return file;", "  plainFile(file);\n  return file;"),
    sl("a linked file is used for a name", "  plainFolder(dir);\n  plainFile(file);\n  return file;", "  plainFolder(dir);\n  return file;"),
    sl("a linked folder is listed", "  plainFolder(dir);\n  const out: ModelInfo[] = [];", "  const out: ModelInfo[] = [];"),
    sl("a folder with a file name is listed", "    if (!st.isFile()) continue;", "    if (false as boolean) continue;"),
    sl("a link is followed when checking a folder", "    st = lstatSync(dir);", "    st = statSync(dir);"),
    sl("a folder is accepted as a storage folder whatever it is", "  if (!st.isDirectory()) throw", "  if (false as boolean) throw"),
    sl("a file that is not a plain file is accepted", "  if (!st.isFile()) throw new StorageError('E_LINK', 'the saved file", "  if (false as boolean) throw new StorageError('E_LINK', 'the saved file"),
    sl("a missing folder is an error", "    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // not made yet: nothing to follow", "    if (false as boolean) return; // not made yet: nothing to follow"),
    sl("a new file is an error", "    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // a new file", "    if (false as boolean) return; // a new file"),
    sl("the temporary file is written through whatever is there", "writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });\n      break;", "writeFileSync(tmp, text, { encoding: 'utf8' });\n      break;"),
    sl("a taken temporary name is not retried", "if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 4) throw e;", "throw e;"),
    sl("a taken temporary name is retried for ever", "|| attempt >= 4) throw e;", ") throw e;"),
    # not mutated: retrying on any error (not only EEXIST) throws the same error after five tries, so only the number of tries differs
    sl("the project folder is not resolved once", "const projectRoot = existsSync(opts.projectDir) ? realpathSync(opts.projectDir) : path.resolve(opts.projectDir);", "const projectRoot = path.resolve(opts.projectDir);", ROOT / "src/server/app.ts"),
]


THA_SUITE = ("tests/unit/server-th-answers.test.ts", 120)


def ta(name: str, old: str, new: str, f: pathlib.Path = APP) -> tuple:
    return (f"th answers: {name}", f, old, new, THA_SUITE)


MUTATIONS += [
    ta("answers are kept with the criteria", "const answersDir = path.join(projectRoot, 'th-answers');", "const answersDir = path.join(projectRoot, 'th-criteria');"),
    ta("the list shows the criteria", "{ answers: listModels(answersDir) }", "{ answers: listModels(criteriaDir) }"),
    ta("an answer is read from the criteria folder", "text: readModel(answersDir, name) }", "text: readModel(criteriaDir, name) }"),
    ta("an answer is saved in the criteria folder", "writeModel(answersDir, name, needText", "writeModel(criteriaDir, name, needText"),
    ta("a missing answer is called a model", "no saved answer called", "no saved model called"),
    ta("an invalid answer is matched to a criterion", "const found = v.valid ? findCriterionByHash(", "const found = true ? findCriterionByHash("),
    ta("the criterion is matched on the wrong hash", "findCriterionByHash((JSON.parse(text) as ThAnswer).criterion_hash)", "findCriterionByHash((JSON.parse(text) as ThAnswer).plant.model_hash)"),
    ta("any criterion matches", "criterionHash(doc as ThCriterion) === wanted", "true"),
    ta("a criterion that is not valid can match", "      if (!validateCriterion(doc).valid) {", "      if (false as boolean) {"),
    ta("the oldest match is named", "for (const c of saved.slice(0, MAX_CRITERIA_SEARCHED)) {", "for (const c of saved.slice(0, MAX_CRITERIA_SEARCHED).reverse()) {"),
    ta("the search covers every criterion", "for (const c of saved.slice(0, MAX_CRITERIA_SEARCHED)) {", "for (const c of saved) {"),
    ta("the search does not say it was cut short", "let complete = saved.length <= MAX_CRITERIA_SEARCHED;", "let complete = true;"),
    ta("the search says it was cut short at the limit", "let complete = saved.length <= MAX_CRITERIA_SEARCHED;", "let complete = saved.length < MAX_CRITERIA_SEARCHED;"),
    ta("the search is not counted", "      searched++;\n", ""),
    ta("a criterion that cannot be read leaves the search complete", "        unreadable++;\n        complete = false;\n        continue;", "        unreadable++;\n        continue;"),
    ta("a criterion that cannot be read is not counted", "        unreadable++;\n        complete = false;\n        continue;", "        complete = false;\n        continue;"),
    ta("a criterion that cannot be parsed is not counted", "      } catch {\n        notValid++;\n        continue;", "      } catch {\n        continue;"),
    ta("the bytes read are not added up", "      bytes += Buffer.byteLength(ctext, 'utf8');\n", ""),
    ta("the byte limit is not applied", "      if (bytes >= MAX_CRITERIA_BYTES_SEARCHED) {", "      if (false as boolean) {"),
    ta("the byte limit does not say the search was cut short", "        complete = false;\n        break;", "        break;"),
    ta("the answer check is skipped", "const v = validateAnswerText(text);", "const v = { valid: true, errors: [] as never[] };"),
    ta("the answer check reads the criterion rules", "const v = validateAnswerText(text);", "const v = validateCriterionText(text);"),
    ta("the counts are left out of the reply", "criteria_not_valid: found.notValid, criteria_unreadable: found.unreadable, ", ""),
]


THJ_SUITE = ("tests/unit/server-th-judge.test.ts", 150)


def tj(name: str, old: str, new: str, f: pathlib.Path = APP) -> tuple:
    return (f"th judge: {name}", f, old, new, THJ_SUITE)


MUTATIONS += [
    tj("records are kept with the criteria", "const mutationsDir = path.join(projectRoot, 'th-mutations');", "const mutationsDir = path.join(projectRoot, 'th-criteria');"),
    tj("the list shows the criteria", "{ mutations: listModels(mutationsDir) }", "{ mutations: listModels(criteriaDir) }"),
    tj("a record is read from the criteria folder", "text: readModel(mutationsDir, name) }", "text: readModel(criteriaDir, name) }"),
    tj("a record is saved in the criteria folder", "writeModel(mutationsDir, name, needText", "writeModel(criteriaDir, name, needText"),
    tj("a missing record is called a model", "no saved mutation record called", "no saved model called"),
    tj("the plant hashes are never taken for a record check", "const plants = body.plant_models === undefined ? null : plantModelHashes(body.plant_models);", "const plants = null;"),
    tj("the record check always says the models were checked", "modelsChecked: plants !== null,", "modelsChecked: true,"),
    tj("the record hash is left out", "mutation_hash = mutationHash(JSON.parse(text) as ThMutation);", "mutation_hash = null;"),
    tj("plant hashes may be a list", "if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'E_FIELD', 'the field \"plant_models\"", "if (typeof v !== 'object' || v === null) throw new HttpError(400, 'E_FIELD', 'the field \"plant_models\""),
    tj("plant hashes may be many", "if (entries.length > 50)", "if (entries.length > 5000)"),
    tj("a plant name may be empty", "if (name.length === 0 || name.length > 200)", "if (name.length > 200)"),
    tj("a plant name may be long", "if (name.length === 0 || name.length > 200)", "if (name.length === 0)"),
    tj("a plant hash may be anything", "typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)", "typeof hash !== 'string'"),
    tj("an engine build may be left out", "build: field('build') };", "build: 'unknown' };"),
    tj("an engine name may be left out", "return { name: field('name'),", "return { name: 'unknown',"),
    tj("an engine version may be left out", "version: field('version'),", "version: 'unknown',"),
    tj("an engine field may be empty", "x.length === 0 || x.length > 200", "x.length > 200"),
    tj("an engine field may be long", "x.length === 0 || x.length > 200", "x.length === 0"),
    tj("a criterion name may be anything", "if (typeof v !== 'string' || !isValidModelName(v)) throw new HttpError(400, 'E_FIELD', `the field", "if (typeof v !== 'string') throw new HttpError(400, 'E_FIELD', `the field"),
    tj("an optional name is required", "          if (optional) return null;", "          if (false as boolean) return null;"),
    tj("a missing plant model is guessed", "    if (missing.length) throw new HttpError(400, 'E_PLANT_UNKNOWN'", "    if (false as boolean) throw new HttpError(400, 'E_PLANT_UNKNOWN'"),
    tj("the plant models of the record are not needed", "(rec ? [rec.base_model.name, rec.mutated_model.name] : [])", "[]"),
    tj("the event tree hash is taken from the criterion", "treeHash: tree?.hash ?? '',", "treeHash: crit ? crit.applies_to.event_tree.tree_hash : '',"),
    tj("the headings of the tree are assumed", "treeHeadings: tree?.headings ?? new Set<string>(),", "treeHeadings: new Set(['H1']),"),
    tj("the plant model hash is taken from the criterion", "plantModelHash: crit ? plants.get(crit.plant.model_name)! : '',", "plantModelHash: crit ? crit.plant.model_hash : '',"),
    tj("the engine is assumed", "plantModelHash: crit ? plants.get(crit.plant.model_name)! : '', engine },", "plantModelHash: crit ? plants.get(crit.plant.model_name)! : '', engine: { name: 'hand', version: '1', build: 'b1' } },"),
    tj("the models of the record are not looked up", "{ resolveModel: (n) => (plants.has(n) ? { hash: plants.get(n)! } : null) },\n      );", "{ resolveModel: () => ({ hash: 'f'.repeat(64) }) },\n      );"),
    tj("the record is not passed to the judgement", "        mutation ? mutation.doc : null,\n", "        null,\n"),
    tj("the judged-with record names no tree", "event_tree: crit ? { name: crit.applies_to.event_tree.name, hash: tree?.hash ?? null } : null,", "event_tree: null,"),
    tj("the judged-with record names no plant models", "plant_models: Object.fromEntries(needed.map((n) => [n, plants.get(n)!])),", "plant_models: {},"),
    tj("the judged-with record names no engine", "          plant_models: Object.fromEntries(needed.map((n) => [n, plants.get(n)!])),\n          engine,", "          plant_models: Object.fromEntries(needed.map((n) => [n, plants.get(n)!])),"),
    tj("a mutation record text check ignores the models", "  return validateMutation(doc, ctx);\n}\n\n/**\n * Hash of what the record MEANS", "  return validateMutation(doc);\n}\n\n/**\n * Hash of what the record MEANS", ROOT / "src/core/th-mutation.ts"),
]


ANSI = re.compile(chr(27) + r"\[[0-9;]*m")


def run_tests(suite: tuple[str, int] = UNIT) -> tuple[bool | None, str]:
    """Returns (passed, summary). passed is None when the run timed out and was killed."""
    target, limit = suite
    command = target[4:] if target.startswith("cmd:") else f"npx vitest run {target}"
    proc = subprocess.Popen(command, cwd=ROOT, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    try:
        out, _ = proc.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        proc.communicate()
        return None, f"TIMEOUT after {limit}s"
    out = ANSI.sub("", out or "")
    m = re.search(r"^\s*Tests\s+(.*)$", out, re.MULTILINE)
    if not m:  # Playwright prints "N passed" / "N failed" lines instead
        pw = re.findall(r"^\s*(\d+ (?:passed|failed|flaky)[^\n]*)$", out, re.MULTILINE)
        return proc.returncode == 0, (" | ".join(pw) if pw else "no test summary (crash)")
    summary = m.group(1).strip()
    if proc.returncode != 0:  # name what failed, so a red baseline can be told from a flaky test at a glance
        names = [l.strip()[:140] for l in out.splitlines() if l.strip().startswith(("\u00d7", "FAIL"))][:4]
        if names:
            summary += " | " + " | ".join(names)
    return proc.returncode == 0, summary


def hashed_files() -> set[str]:
    """The files the built-in engine's identity hashes (the list in the generated build-id.ts): a mutant in one of them must not be caught
    only because the committed identity no longer matches."""
    text = (ROOT / "src/engines/bdd/build-id.ts").read_text(encoding="utf-8")
    return set(re.findall(r'"((?:src|schema)/[^"]+)"', text))


def recover() -> None:
    """Restore any file left mutated by an interrupted earlier run. Stash format: relative path, newline, original bytes."""
    if not BACKUP.exists():
        return
    for stash in BACKUP.glob("*.orig"):
        raw = stash.read_bytes()
        rel, original = raw.split(b"\n", 1)
        target = ROOT / rel.decode("utf-8")
        target.write_bytes(original)
        print(f"recovered {rel.decode('utf-8')} from an interrupted run")
        stash.unlink()
    BACKUP.rmdir()


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    only = sys.argv[1] if len(sys.argv) > 1 else "all"  # all | unit | engine | check
    recover()
    chosen = [m for m in MUTATIONS if only in ("all", "check") or (only == "unit") == (len(m) == 4) and only in ("unit", "engine")]
    if only == "web":  # just the editor and server mutations
        web = {WD, WV, WE, WC, WP, WS, WR, WL, SL, SA, ST, CM, SR, WK}
        chosen = [m for m in MUTATIONS if m[1] in web]
    if only == "compare":  # just the compare-runs mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("compare:", "runs:", "ui compare:", "editor: a failed comparison", "editor: a slow older", "editor: clearing does not", "editor: a listing failure"))]
    if only == "engines":  # just the built-in engine and engine-choice mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("bdd:", "crosscheck:", "engine choice:", "result: MCUB", "result: zero"))]
    if only == "timeout":  # just the time-limit and report-size mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("analyze:", "result: a result is accepted", "result: an unread", "result: the report size", "result: an over-long", "result: too many", "result: the minimality", "result: sets of", "result: a subset", "result: a timeout", "result: non-minimal", "analyze: report read"))]
    if only == "seed":  # just the SEED-side mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("headless:", "seed oracle:", "engine: hasOwned", "engine: a failed process", "analyze:"))]
    if only == "import":  # just the importer mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("import:")]
    if only == "queue":  # just the queue and saved-run reuse mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("queue:")]
    if only == "export":  # just the figure and print mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("figure:")]
    if only == "scrub":  # just the publication scrub mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("scrub:")]
    if only == "importance":  # just the importance measure mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("importance:")]
    if only == "engineid":  # just the built-in engine identity mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("engine id:")]
    if only == "eventtree":  # just the event tree mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("event tree:")]
    if only == "etengine":  # just the event tree engine mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("event tree engine:")]
    if only == "etui":  # just the event tree editor mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("event tree editor:")]
    if only == "ets4":  # just the event tree drawing, saved-analysis and compare mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("event tree s4:")]
    if only == "etlesson":  # just the event tree lesson mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("event tree lesson:")]
    if only == "etundo":  # just the event tree undo and headless verb mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("event tree undo:", "event tree headless:"))]
    if only == "thlink":  # just the thermal-hydraulic criterion (plan 14, stage T0) mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("th criterion:")]
    if only == "thmutation":  # just the plant-model mutation record (plan 14, stage T1) mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("th mutation:")]
    if only == "throutes":  # just the success-criterion folder and route mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("th routes:")]
    if only == "storlinks":  # just the storage link-refusal mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("storage links:")]
    if only == "thanswers":  # just the answer-record folder and route mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("th answers:")]
    if only == "thjudge":  # just the mutation-record route and judgement route mutations
        chosen = [m for m in MUTATIONS if m[0].startswith("th judge:")]
    if only == "lessons":  # just the lesson mutations
        chosen = [m for m in MUTATIONS if "lesson" in m[0] or m[0].startswith("editor: a lesson") or "hand calculation" in m[0]]
    if only == "check":
        bad = [m[0] for m in MUTATIONS if m[1].read_bytes().decode("utf-8").count(m[2]) != 1]
        print(f"{len(MUTATIONS) - len(bad)} of {len(MUTATIONS)} patterns occur exactly once", ("; fix: " + ", ".join(bad)) if bad else "")
        return 1 if bad else 0
    suites = {UNIT} | {m[4] for m in chosen if len(m) == 5}
    for suite in sorted(suites):
        t0 = time.time()
        ok, summary = run_tests(suite)
        print(f"baseline {suite[0]}: {'green' if ok else 'RED'} ({summary}) in {time.time() - t0:.0f}s")
        if not ok:
            return 2
    survived: list[str] = []
    timed_out: list[str] = []
    BACKUP.mkdir(exist_ok=True)
    for m in chosen:
        name, path, old, new = m[:4]
        suite = m[4] if len(m) == 5 else UNIT
        original = path.read_bytes()
        text = original.decode("utf-8")
        if text.count(old) != 1:
            print(f"SKIP (pattern occurs {text.count(old)} times, update this script): {name}")
            survived.append(name + " [pattern problem]")
            continue
        stash = BACKUP / (path.name + ".orig")
        stash.write_bytes(path.relative_to(ROOT).as_posix().encode("utf-8") + b"\n" + original)
        # A mutant in a file the built-in engine's identity hashes would fail the identity test for that reason alone and hide real gaps:
        # regenerate build-id.ts for the mutant (and put the original back afterwards), so the mutant is judged by its behaviour.
        rel = path.relative_to(ROOT).as_posix()
        regen = rel in hashed_files()
        bid = ROOT / "src/engines/bdd/build-id.ts"
        bid_original = bid.read_bytes() if regen else b""
        bid_stash = BACKUP / "build-id.ts.orig"
        if regen:
            bid_stash.write_bytes(b"src/engines/bdd/build-id.ts\n" + bid_original)
        try:
            path.write_bytes(text.replace(old, new, 1).encode("utf-8"))
            if regen:
                try:
                    gen = subprocess.run("npx tsx scripts/gen-engine-id.ts", cwd=ROOT, shell=True, capture_output=True, timeout=120)
                except subprocess.TimeoutExpired:
                    gen = None
                if gen is None or gen.returncode != 0:  # never judge a mutant against a stale identity: that would count as caught for the wrong reason
                    print(f"INFRASTRUCTURE ERROR  {name}: the engine identity could not be regenerated" + (f": {gen.stderr.decode('utf-8', 'replace')[-300:]}" if gen else " (timeout)"))
                    survived.append(name + " [infrastructure error]")
                    continue
            green, summary = run_tests(suite)
        finally:
            path.write_bytes(original)
            stash.unlink(missing_ok=True)
            if regen:
                bid.write_bytes(bid_original)
                bid_stash.unlink(missing_ok=True)
        if green is None:
            timed_out.append(name)
            print(f"TIMEOUT  {name}: {summary} (hang; counted as caught, but the test should fail fast)")
        else:
            print(f"{'SURVIVED' if green else 'caught  '} {name}: {summary}")
            if green:
                survived.append(name)
    BACKUP.rmdir()
    ok, summary = run_tests(UNIT)
    print(f"restored: unit suite {'green' if ok else 'RED'} ({summary})")
    print(f"{len(chosen) - len(survived)} of {len(chosen)} mutations caught ({len(timed_out)} only by timeout)")
    return 1 if survived or not ok else 0


if __name__ == "__main__":
    sys.exit(main())
