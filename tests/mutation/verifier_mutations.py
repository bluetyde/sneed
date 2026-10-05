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
B = ROOT / "src/core/bounds.ts"
A = ROOT / "src/core/analyze.ts"
N = ROOT / "src/core/engine.ts"
RC = ROOT / "src/runtime/recipe.ts"
RT = ROOT / "src/runtime/install.ts"
SM = ROOT / "src/runtime/smoke.ts"

# Test selection and time limit (seconds) per mutation. Engine suites need WSL and the pinned SCRAM build.
UNIT = ("tests/unit", 180)
PROCESS = ("tests/engine/process.test.ts", 420)
HEADLESS = ("tests/engine/headless.test.ts", 1500)
SMOKE = ("tests/engine/smoke.test.ts", 900)

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
    ("result: non-minimal cut sets accepted", Rs, "sets[i]!.length < sets[j]!.length", "false as boolean"),
    ("result: clamp warning ignored for exact", Rs, "if (adjusted && settings.method === 'exact' && !close(report.probability, 1))", "if (false as boolean)"),
    # structural bound
    ("bounds: AND takes the maximum", B, "if (g.type === 'and') b = vals.reduce((x, y) => x + y, 0);", "if (g.type === 'and') b = Math.max(...vals);"),
    ("bounds: OR takes the sum", B, "else if (g.type === 'or') b = Math.max(...vals);", "else if (g.type === 'or') b = vals.reduce((x, y) => x + y, 0);"),
    # run layer (need the engine)
    ("analyze: validation skipped", A, "if (!validation.valid) return", "if (false as boolean) return", HEADLESS),
    ("analyze: default limit is the engine's own 20", A, "limitOrder: Math.max(1, events.length)", "limitOrder: 20", HEADLESS),
    ("analyze: engine pin not enforced", A, "if (engineCfg.expectedSha256 && identity.sha256 !== engineCfg.expectedSha256) {", "if (false as boolean) {", HEADLESS),
    ("analyze: always writes SCRAM's atleast", A, "exportOpenPsa(model, opts.voting ? { voting: opts.voting } : {})", "exportOpenPsa(model, { voting: 'native' })", HEADLESS),
    ("analyze: report read even after the run failed to produce one", A, "existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null", "'<report/>'", HEADLESS),
    ("engine: cancel does not kill the owned process", N, "      killOwned(distro, opts.ownerTag);\n", "", PROCESS),
    ("engine: owner tag not regex-escaped", N, "const pattern = regexEscape(ownerTag);", "const pattern = ownerTag;", PROCESS),
    ("engine: timeout never fires", N, "const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);", "const timer = setTimeout(() => undefined, opts.timeoutMs);", PROCESS),
    ("engine: cancellation after exit still recorded", N, "      if (settled) return;\n      settled = true;\n      if (why", "      settled = true;\n      if (why", PROCESS),
    ("engine: owner tag length not checked", N, "if (ownerTag.length < 12)", "if (false as boolean)", PROCESS),
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
    ("resolve: manifest integrity not checked", RT, "|| sha256(readFileSync(manifestFile)) !== active.manifest_sha256) throw new Error('the active runtime manifest is missing or changed');", ") throw new Error('the active runtime manifest is missing or changed');"),
    ("rollback: previous runtime not verified", RT, "if (issues.length) throw new Error(`the previous runtime does not verify", "if (false as boolean) throw new Error(`the previous runtime does not verify"),
    ("rollback: allowed while an install holds the lock", RT, "if (existsSync(path.join(dir, 'lock.json'))) throw new RuntimeBusyError(", "if (false as boolean) throw new RuntimeBusyError("),
    # smoke checker (needs the engine)
    ("smoke: probability not compared", SM, "else if (Math.abs((r.top_event_probability ?? Number.NaN) - c.expected_probability) > Math.max(1e-12, 1e-5 * c.expected_probability)) reason = 'probability-differs';", "else if (false as boolean) reason = 'probability-differs';", SMOKE),
    ("smoke: cut sets not compared", SM, "else if (JSON.stringify(sorted(r.minimal_cut_sets.map((x) => x.events))) !== JSON.stringify(sorted(c.expected_cut_sets))) reason = 'cut-sets-differ';", "else if (false as boolean) reason = 'cut-sets-differ';", SMOKE),
    ("smoke: refused model counts as passed", SM, "out.push({ id: c.id, passed: false, reason: `refused:", "out.push({ id: c.id, passed: true, reason: `refused:", SMOKE),
]

ANSI = re.compile(chr(27) + r"\[[0-9;]*m")


def run_tests(suite: tuple[str, int] = UNIT) -> tuple[bool | None, str]:
    """Returns (passed, summary). passed is None when the run timed out and was killed."""
    target, limit = suite
    proc = subprocess.Popen(f"npx vitest run {target}", cwd=ROOT, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    try:
        out, _ = proc.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        proc.communicate()
        return None, f"TIMEOUT after {limit}s"
    out = ANSI.sub("", out or "")
    m = re.search(r"^\s*Tests\s+(.*)$", out, re.MULTILINE)
    return proc.returncode == 0, (m.group(1).strip() if m else "no test summary (crash)")


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
