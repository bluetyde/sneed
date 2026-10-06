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
    ("editor: a result never goes stale on a model change", WE, "return r.input_hashes.model_hash !== this.validation?.model_hash || r.method !== this.method;", "return r.method !== this.method;"),
    ("editor: a result never goes stale on a method change", WE, "return r.input_hashes.model_hash !== this.validation?.model_hash || r.method !== this.method;", "return r.input_hashes.model_hash !== this.validation?.model_hash;"),
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
    ("server: disconnect does not stop the engine", SA, "if (!res.writableEnded) job.abort.abort(); // the browser went away: stop the engine", ""),
    ("server: a second run is allowed", SA, "if (running) throw new HttpError(409, 'E_BUSY', 'a run is already in progress');", ""),
    ("storage: unsafe names accepted", ST, "if (!isValidModelName(name)) throw new StorageError('E_NAME'", "if (false as boolean) throw new StorageError('E_NAME'"),
    # browser: builds the app from the mutated source and drives real Chrome
    ("ui canvas: arrow keys do nothing", WC, "if (key && dirs[e.key]) {", "if (false as boolean) {", E2E),
    ("ui canvas: a finished drag is not recorded", WC, "if (n) this.editor.moveNode(d.key!, n.x, n.y);", "", E2E),
    ("ui canvas: drag-to-connect does nothing", WC, "if (node && target !== d.key) this.editor.connect(d.fromGate!, node.id);", "if (false as boolean) this.editor.connect(d.fromGate!, node.id);", E2E),
    ("ui properties: an out-of-range probability is accepted", WP, "if (v < 0 || v > 1) return this.refuse(", "if (false as boolean) return this.refuse(", E2E),
    ("ui shell: Ctrl+Enter does not run", WS, "} else if (mod && e.key === 'Enter') {", "} else if (false as boolean) {", E2E),
    ("ui shell: Escape does not cancel a run", WS, "if (editor.running) void editor.cancel();", "", E2E),
    ("ui shell: no guard against leaving with unsaved work", WS, "window.addEventListener('beforeunload', (e) => {\n    if (editor.dirty) {", "window.addEventListener('beforeunload', (e) => {\n    if (false as boolean) {", E2E),
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
    ("server: lessons served without configuration", SA, "if (!opts.lessonsDir || !opts.oraclesFile) throw new HttpError(503, 'E_LESSONS_UNAVAILABLE', 'lessons are not configured');", ""),
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
    ("runs: listing is oldest first", SR, ".sort().reverse().slice(0, MAX_LISTED_RUNS * 2)", ".sort().slice(0, MAX_LISTED_RUNS * 2)"),
    ("editor: a failed comparison keeps showing the old one", WE, "      this.comparison = null;\n      this.compareError = `Could not load the runs:", "      this.compareError = `Could not load the runs:"),
    ("ui compare: the choice follows new runs after the student picked", WK, "if (!this.chosen || !ids.includes(this.a) || !ids.includes(this.b)) {", "if (!ids.includes(this.a) || !ids.includes(this.b)) {", E2E),
    ("ui compare: the unexpected-difference warning is never shown", WK, "if (r.sameInputs && p.delta !== null && p.delta !== 0) {", "if (false as boolean) {", E2E),
    # SEED side (plan 11): the headless runner and the generated oracle entries
    ("headless: a truncated result is written as a result", HL, "if (rec.status !== 'completed' || rec.completeness !== 'complete') {", "if (rec.status !== 'completed') {"),
    ("headless: an invalid model reaches the engine", HL, "if (!v.valid) return reply({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(warnTyped) }, 2);\n    let engine: EngineConfig;", "let engine: EngineConfig;"),
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
    # smoke checker (needs the engine)
    ("smoke: probability not compared", SM, "else if (Math.abs((r.top_event_probability ?? Number.NaN) - c.expected_probability) > Math.max(1e-12, 1e-5 * c.expected_probability)) reason = 'probability-differs';", "else if (false as boolean) reason = 'probability-differs';", SMOKE),
    ("smoke: cut sets not compared", SM, "else if (JSON.stringify(sorted(r.minimal_cut_sets.map((x) => x.events))) !== JSON.stringify(sorted(c.expected_cut_sets))) reason = 'cut-sets-differ';", "else if (false as boolean) reason = 'cut-sets-differ';", SMOKE),
    ("smoke: refused model counts as passed", SM, "out.push({ id: c.id, passed: false, reason: `refused:", "out.push({ id: c.id, passed: true, reason: `refused:", SMOKE),
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
    return proc.returncode == 0, m.group(1).strip()


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
    if only == "timeout":  # just the time-limit and report-size mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("analyze:", "result: a result is accepted", "result: an unread", "result: the report size", "result: an over-long", "result: too many", "result: the minimality", "result: sets of", "result: a subset", "result: a timeout", "result: non-minimal", "analyze: report read"))]
    if only == "seed":  # just the SEED-side mutations
        chosen = [m for m in MUTATIONS if m[0].startswith(("headless:", "seed oracle:", "engine: hasOwned", "engine: a failed process", "analyze:"))]
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
        try:
            path.write_bytes(text.replace(old, new, 1).encode("utf-8"))
            green, summary = run_tests(suite)
        finally:
            path.write_bytes(original)
            stash.unlink(missing_ok=True)
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
