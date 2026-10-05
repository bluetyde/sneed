"""P0 spike probes: failure behaviour, truncation, determinism, hostile XML, native voting."""
import hashlib
import json
import re
from run_oracles import *  # noqa: F401,F403
from run_oracles import INPUTS, RUNS, run_scram, parse_report, model_xml, f, ev, A, B, C, METHOD_ARGS

out = {}


def probe(tag, xml, args=("--bdd", "--probability", "true"), raw=None):
    p = INPUTS / f"{tag}.xml"
    if raw is not None:
        p.write_bytes(raw)
    else:
        p.write_text(xml, newline="\n")
    rec, rep = run_scram(tag, p, list(args))
    res = {"exit": rec["exit"], "report": rec["report_exists"], "stderr": " ".join(rec["stderr"].split())[:300]}
    if rec["report_exists"]:
        try:
            res["parsed"] = parse_report(rep)[:2]
        except Exception as e:  # noqa
            res["parse_error"] = str(e)
    out[tag] = res
    print(tag, json.dumps(res))
    return rec, rep


# failure behaviour
probe("pra-bad-prob", model_xml({"A": 1.2, "B": 0.2}, f("and", A, B)))
probe("pra-neg-prob", model_xml({"A": -0.1, "B": 0.2}, f("and", A, B)))
probe("pra-missing", model_xml({"A": 0.1}, f("and", A, ev("ZZ"))))
cyc = ('<?xml version="1.0"?><opsa-mef><define-fault-tree name="FT">'
       '<define-gate name="TOP"><and><gate name="G2"/><basic-event name="A"/></and></define-gate>'
       '<define-gate name="G2"><or><gate name="TOP"/><basic-event name="A"/></or></define-gate>'
       '<define-basic-event name="A"><float value="0.1"/></define-basic-event></define-fault-tree></opsa-mef>')
probe("pra-cycle", cyc)
probe("malformed-xml", "", raw=b"<opsa-mef><define-fault-tree")
probe("empty-file", "", raw=b"")
# nonexistent input
rec, _ = run_scram("nonexistent", INPUTS / "does-not-exist.xml", ["--bdd", "--probability", "true"])
out["nonexistent"] = {"exit": rec["exit"], "stderr": " ".join(rec["stderr"].split())[:200]}
print("nonexistent", out["nonexistent"])

# hostile XML: entity expansion and external entity
bomb = ('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">'
        '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><opsa-mef><define-fault-tree name="&c;">'
        '<define-gate name="TOP"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>'
        '<define-basic-event name="A"><float value="0.1"/></define-basic-event>'
        '<define-basic-event name="B"><float value="0.2"/></define-basic-event></define-fault-tree></opsa-mef>')
probe("hostile-entity-expansion", bomb)
xxe = ('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/hostname">]><opsa-mef>'
       '<define-fault-tree name="FT"><define-gate name="TOP"><or><basic-event name="A"/><basic-event name="B"/></or>'
       '</define-gate><define-basic-event name="A"><float value="0.1"/></define-basic-event>'
       '<define-basic-event name="B"><float value="0.2"/></define-basic-event></define-fault-tree>'
       '<label>&e;</label></opsa-mef>')
probe("hostile-external-entity", xxe)

# truncation: product order 3 with limit 2 (default limit is 20: silent cutoff)
t3 = model_xml({"A": 0.1, "B": 0.2, "C": 0.3}, f("and", A, B, C))
probe("trunc-limit-order-2", t3, args=("--bdd", "--probability", "true", "-l", "2"))
probe("trunc-default-limit-order-ok", t3)
cut = model_xml({"A": 0.1, "B": 0.2, "C": 0.3}, f("or", f("and", A, B), C))
probe("trunc-cut-off-0.1", cut, args=("--bdd", "--probability", "true", "--cut-off", "0.1"))
# deep AND of 21 events: exceeds default limit 20 with no flag set by the user
names = [f"E{i}" for i in range(21)]
deep = model_xml({n: 0.5 for n in names}, f("and", *[ev(n) for n in names]))
probe("trunc-default-limit-21-events", deep)
# mocus/zbdd also
probe("trunc-limit-2-zbdd", t3, args=("--zbdd", "--probability", "true", "-l", "2"))

# native atleast (voting) vs expansion
vote = model_xml({"A": 0.1, "B": 0.1, "C": 0.1}, f("atleast", A, B, C, min=2))
probe("native-atleast-2of3", vote)

# determinism: same input twice, compare normalized
inp = INPUTS / "pra-pump3-separate.xml"
norm = []
for i in (1, 2):
    rec, rep = run_scram(f"determinism-{i}", inp, METHOD_ARGS["exact"])
    txt = rep.read_text()
    norm.append(re.sub(r"<time>.*?</time>|<calculation-time.*?</calculation-time>|<products>.*?</products>|<probability>[^<]*</probability>", "", txt, flags=re.S))
    print("determinism raw sha", i, hashlib.sha256(rep.read_bytes()).hexdigest()[:12])
out["determinism_normalized_equal"] = norm[0] == norm[1]
print("determinism normalized equal:", norm[0] == norm[1])
(RUNS / "probe-summary.json").write_text(json.dumps(out, indent=2, default=str), newline="\n")

# voting boundaries (added after the voting decision)
P = {"A": 0.1, "B": 0.1, "C": 0.1}
for tag, formula in {
    "atleast-min1-of3": f("atleast", A, B, C, min=1),
    "atleast-min3-of3": f("atleast", A, B, C, min=3),
    "atleast-min4-of3": f("atleast", A, B, C, min=4),
    "atleast-min2-of2": f("atleast", A, B, min=2),
    "atleast-min0-of3": f("atleast", A, B, C, min=0),
    "atleast-dup-arg": f("atleast", A, A, B, min=2),
}.items():
    probe(tag, model_xml(P, formula))
(RUNS / "probe-summary.json").write_text(json.dumps(out, indent=2, default=str), newline="\n")

# identifier rules (added for the schema spec)
probe("id-case-collision", model_xml({"A": 0.1, "a": 0.2}, f("and", A, ev("a"))))
probe("id-leading-digit", model_xml({"1A": 0.1, "B": 0.2}, f("and", ev("1A"), B)))
probe("id-dot-dash-underscore", model_xml({"P-1.a_b": 0.1, "B": 0.2}, f("and", ev("P-1.a_b"), B)))
probe("id-space", model_xml({"P 1": 0.1, "B": 0.2}, f("and", ev("P 1"), B)))
probe("id-unicode", model_xml({"Pump\u00e9": 0.1, "B": 0.2}, f("and", ev("Pump\u00e9"), B)))
probe("id-event-gate-same-name", model_xml({"X": 0.1, "B": 0.2}, f("and", ev("X"), B), top="X"))
probe("id-gate-named-TOP-lower", model_xml({"A": 0.1, "B": 0.2}, f("and", A, B), top="top"))
probe("id-reserved-and", model_xml({"and": 0.1, "B": 0.2}, f("and", ev("and"), B)))
(RUNS / "probe-summary.json").write_text(json.dumps(out, indent=2, default=str), newline="\n")

for tag, nm in {"id-dash": "P-1", "id-dot": "P.1", "id-underscore": "P_1", "id-upper-lower-digit": "Pump1b", "id-trailing-dash": "P-", "id-leading-underscore": "_P", "id-leading-dash": "-P", "id-leading-dot": ".P"}.items():
    probe(tag, model_xml({nm: 0.1, "B": 0.2}, f("and", ev(nm), B)))
probe("id-unicode-utf8", "", raw=model_xml({"Pump\u00e9": 0.1, "B": 0.2}, f("and", ev("Pump\u00e9"), B)).encode("utf-8"))
long = "E" + "x" * 200
probe("id-length-201", model_xml({long: 0.1, "B": 0.2}, f("and", ev(long), B)))
(RUNS / "probe-summary.json").write_text(json.dumps(out, indent=2, default=str), newline="\n")
