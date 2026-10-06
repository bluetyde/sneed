"""P0 spike: run the frozen oracle models through a pinned SCRAM build and compare.

Expected values come only from tests/oracles.json (frozen before any run). This script
never edits them. Raw reports, stdout/stderr and exit codes are kept in docs/spike/runs/.
SCRAM is called through `wsl --exec` with an explicit argument list (no shell string).
"""
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORACLES = {o["id"]: o for o in json.loads((HERE.parent.parent / "tests" / "oracles.json").read_text())}
RUNS = HERE / "runs"
INPUTS = HERE / "inputs"
SCRAM = "/root/pra-scram/build/bin/scram"
LIBS = "LD_LIBRARY_PATH=/root/pra-scram/build/lib/scram:/root/pra-scram/env-old/lib"
DISTRO = "Ubuntu"


def wsl_path(p: Path) -> str:
    s = str(p.resolve()).replace("\\", "/")
    return "/mnt/" + s[0].lower() + s[2:]


def publishable(text):
    """The run files are published: the project folder becomes <repo> (also URL-encoded, as some engine messages write it), so
    no account name or absolute folder appears in them (publication scrub, docs/PUBLICATION.md)."""
    root = wsl_path(HERE.parent.parent)
    for spelling in (root, root.replace(" ", "%20")):
        text = text.replace(spelling, "<repo>")
    return text


def ev(name):
    return f'<basic-event name="{name}"/>'


def f(op, *args, **attrs):
    a = "".join(f' {k}="{v}"' for k, v in attrs.items())
    return f"<{op}{a}>{''.join(args)}</{op}>"


def model_xml(probs, formula, top="TOP", extra=""):
    be = "".join(
        f'<define-basic-event name="{n}"><float value="{p}"/></define-basic-event>' for n, p in probs.items()
    )
    return (
        '<?xml version="1.0"?>\n<opsa-mef>\n<define-fault-tree name="FT">\n'
        f'<define-gate name="{top}">{formula}</define-gate>\n{extra}{be}\n</define-fault-tree>\n</opsa-mef>\n'
    )


A, B, C = ev("A"), ev("B"), ev("C")
P1, P2, S, S1, S2 = ev("P1"), ev("P2"), ev("S"), ev("S1"), ev("S2")
VOTE_EXP = f("or", f("and", A, B), f("and", A, C), f("and", B, C))
P3 = {"A": 0.1, "B": 0.1, "C": 0.1}

# id -> (probabilities, formula)
MODELS = {
    "pra-and": ({"A": 0.1, "B": 0.2}, f("and", A, B)),
    "pra-or": ({"A": 0.1, "B": 0.2}, f("or", A, B)),
    "pra-aa": ({"A": 0.1}, f("and", A, A)),
    "pra-oa": ({"A": 0.1}, f("or", A, A)),
    "pra-shared": ({"A": 0.1, "B": 0.2, "C": 0.3}, f("or", f("and", A, B), f("and", A, C))),
    "pra-pump1": ({"P": 0.1}, ev("P")),
    "pra-pump2-and": ({"P1": 0.1, "P2": 0.1}, f("and", P1, P2)),
    "pra-pump2-or": ({"P1": 0.1, "P2": 0.1}, f("or", P1, P2)),
    "pra-pump3-shared": ({"P1": 0.1, "P2": 0.1, "S": 0.05}, f("or", S, f("and", P1, P2))),
    "pra-pump3-separate": (
        {"P1": 0.1, "P2": 0.1, "S1": 0.05, "S2": 0.05},
        f("and", f("or", P1, S1), f("or", P2, S2)),
    ),
    "pra-vote-exact": (P3, VOTE_EXP),
    "pra-vote-rare": (P3, VOTE_EXP),
    "pra-vote-mcub": (P3, VOTE_EXP),
}
METHOD_ARGS = {
    "exact": ["--bdd", "--probability", "true"],
    "rare-event": ["--bdd", "--probability", "true", "--rare-event"],
    "mcub": ["--bdd", "--probability", "true", "--mcub"],
}


def run_scram(tag, input_path, args, tolerate=False):
    """Run SCRAM once; keep raw report/stdout/stderr/exit code under runs/<tag>/."""
    d = RUNS / tag
    d.mkdir(parents=True, exist_ok=True)
    out = d / "report.xml"
    if out.exists():
        out.unlink()
    cmd = ["wsl", "-d", DISTRO, "--exec", "env", LIBS, SCRAM, *args, wsl_path(input_path), "-o", wsl_path(out)]
    p = subprocess.run(cmd, capture_output=True, timeout=120)
    rec = {
        "cmd": [c for c in cmd],
        "exit": p.returncode,
        "stdout": p.stdout.decode("utf-8", "replace").replace("\x00", ""),
        "stderr": p.stderr.decode("utf-8", "replace").replace("\x00", ""),
        "report_exists": out.exists(),
    }
    (d / "run.json").write_text(publishable(json.dumps(rec, indent=2)), newline="\n")
    return rec, out


def parse_report(path):
    root = ET.parse(path).getroot()
    sop = root.find("results/sum-of-products")
    sets = sorted(sorted(b.get("name") for b in pr.findall("basic-event")) for pr in sop.findall("product"))
    ver = root.find("information/software").get("version")
    return float(sop.get("probability")), sets, ver, sop.get("probability")


def main():
    INPUTS.mkdir(exist_ok=True)
    rows, fails = [], 0
    for oid, (probs, formula) in MODELS.items():
        o = ORACLES[oid]
        if oid in ("pra-aa", "pra-oa"):
            # Evidence first: SCRAM refuses the duplicate argument as written.
            raw_in = INPUTS / f"{oid}-as-written.xml"
            raw_in.write_text(model_xml(probs, formula), newline="\n")
            rrec, _ = run_scram(f"{oid}-as-written", raw_in, METHOD_ARGS["exact"])
            print(f"{oid}-as-written: exit={rrec['exit']} report={rrec['report_exists']} (expected refusal)")
            # Exporter normalization (plan 01): duplicate inputs on one gate collapse to the single reference.
            formula = ev("A")
        inp = INPUTS / f"{oid}.xml"
        inp.write_text(model_xml(probs, formula), newline="\n")
        rec, out = run_scram(oid, inp, METHOD_ARGS[o["method"]])
        if rec["exit"] != 0 or not rec["report_exists"]:
            rows.append((oid, "RUN-FAIL", rec["exit"], rec["stderr"][:200]))
            fails += 1
            continue
        prob, sets, ver, raw = parse_report(out)
        exp_sets = sorted(sorted(s) for s in o["expected_cut_sets"])
        dp = abs(prob - o["expected_probability"])
        ok = dp <= o["tolerance"]["absolute"] and sets == exp_sets
        fails += not ok
        rows.append((oid, "PASS" if ok else "FAIL", raw, f"|d|={dp:.3g} sets_ok={sets == exp_sets}"))
    for r in rows:
        print(*r)
    print("failures:", fails, "of", len(rows))
    return fails


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
