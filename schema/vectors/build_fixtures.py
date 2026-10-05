"""Writes the good and bad fixtures plus expected.json. Expected issue sets are written here from
docs/SCHEMA.md, not copied from validator output. Re-run to regenerate; files are written with LF."""
import copy
import json
import pathlib

HERE = pathlib.Path(__file__).parent
HEAD = {"schema": {"id": "sneed.fault-tree", "version": 1},
        "model": {"id": "m1", "name": "Fixture", "created": "2026-10-05T00:00:00Z", "updated": "2026-10-05T00:00:00Z"},
        "assumptions": {"probability_model": "constant", "independence": "declared-independent", "coherence": "coherent", "time": "none"}}


def doc(top, events, gates, **extra):
    d = copy.deepcopy(HEAD)
    d["top"] = top
    d["events"] = [{"id": k, "probability": v} for k, v in events.items()]
    d["gates"] = [{"id": k, "type": t, "inputs": i, **({"threshold": th} if th is not None else {})} for k, t, i, th in gates]
    d.update(extra)
    return d


def AND(i, inputs): return (i, "and", inputs, None)
def OR(i, inputs): return (i, "or", inputs, None)
def VOTE(i, inputs, k): return (i, "atleast", inputs, k)


pump3 = doc("TOP", {"P1": 0.1, "P2": 0.1, "S": 0.05}, [OR("TOP", ["S", "PUMPS"]), AND("PUMPS", ["P1", "P2"])])
pump3["events"][0].update({"name": "Pump 1", "source": {"kind": "synthetic"}, "note": "lesson 2",
                           "link": {"app": "nodal", "component_id": "pump-1", "revision": "r1", "review": "needs-review"}})
pump3["events"][2]["source"] = {"kind": "sourced", "citation": "NUREG/CR-6928 (example citation)"}
pump3["layout"] = {"nodes": [{"id": "TOP", "x": 0, "y": 0}, {"id": "PUMPS", "x": 1, "y": 1}],
                   "references": [{"node": "ref-1", "target": "S", "x": 2, "y": 1}]}
three = {"A": 0.1, "B": 0.1, "C": 0.1}
warn = doc("TOP", {"A": 0.1, "B": 0.2, "U": 0.3}, [AND("TOP", ["A", "B"]), AND("G9", ["A", "B"])],
           layout={"nodes": [{"id": "GHOST", "x": 0, "y": 0}], "references": [{"node": "r", "target": "NOPE", "x": 0, "y": 0}]})
warn["x-note"] = {"kept": True}
warn["events"][0]["x-owner"] = "student"

# name -> (document or raw text, expected errors, expected warnings); lists are codes, order-insensitive
good = {
    "pump3-shared": (pump3, [], []),
    "single-event-top": (doc("P", {"P": 0.1}, []), [], []),
    "voting-2-of-3": (doc("V", three, [VOTE("V", ["A", "B", "C"], 2)]), [], []),
    "and-duplicate-input": (doc("TOP", {"A": 0.1}, [AND("TOP", ["A", "A"])]), [], []),
    "case-distinct-ids": (doc("TOP", {"A": 0.1, "a": 0.2}, [AND("TOP", ["A", "a"])]), [], []),
    "id-64-chars": (doc("TOP", {"E" + "x" * 63: 0.1, "B": 0.2}, [AND("TOP", ["E" + "x" * 63, "B"])]), [], []),
    "probability-bounds": (doc("TOP", {"A": 0, "B": 1}, [OR("TOP", ["A", "B"])]), [], []),
    "warnings-only": (warn, [], ["W_UNKNOWN_FIELD", "W_UNKNOWN_FIELD", "W_UNREACHABLE", "W_UNREACHABLE", "W_LAYOUT_STALE", "W_LAYOUT_STALE"]),
}
ab = {"A": 0.1, "B": 0.2}


def mod(base, fn):
    d = copy.deepcopy(base)
    fn(d)
    return d


base = doc("TOP", ab, [AND("TOP", ["A", "B"])])
bad = {
    "E_SCHEMA__assumption-not-v1": (mod(base, lambda d: d["assumptions"].update(independence="dependent")), ["E_SCHEMA"], []),
    "E_SCHEMA__schema-version-2": (mod(base, lambda d: d["schema"].update(version=2)), ["E_SCHEMA"], []),
    "E_SCHEMA__gate-type-unknown": (mod(base, lambda d: d["gates"][0].update(type="xor")), ["E_SCHEMA"], []),
    "E_SCHEMA__threshold-on-and": (mod(base, lambda d: d["gates"][0].update(threshold=2)), ["E_SCHEMA"], []),
    "E_SCHEMA__sourced-without-citation": (mod(base, lambda d: d["events"][0].update(source={"kind": "sourced"})), ["E_SCHEMA"], []),
    "E_SCHEMA__missing-model-block": (mod(base, lambda d: d.pop("model")), ["E_SCHEMA"], []),
    "E_SCHEMA__not-an-object": ([1, 2, 3], ["E_SCHEMA"], []),
    "E_SCHEMA__invalid-json": ('{"schema": {"id": ', ["E_SCHEMA"], []),
    "E_ID_FORMAT__leading-digit": (doc("TOP", {"1A": 0.1, "B": 0.2}, [AND("TOP", ["1A", "B"])]), ["E_ID_FORMAT"], []),
    "E_ID_FORMAT__dot": (doc("TOP", {"P.1": 0.1, "B": 0.2}, [AND("TOP", ["P.1", "B"])]), ["E_ID_FORMAT"], []),
    "E_DUP_ID__two-events": (doc("TOP", {"B": 0.2}, [AND("TOP", ["A", "B"])]) | {"events": [{"id": "A", "probability": 0.1}, {"id": "A", "probability": 0.2}, {"id": "B", "probability": 0.2}]}, ["E_DUP_ID"], []),
    "E_DUP_ID__two-gates": (doc("TOP", ab, [AND("TOP", ["A", "B"]), OR("TOP", ["A", "B"])]), ["E_DUP_ID"], []),
    "E_DUP_ID__event-gate-clash": (doc("TOP", ab, [AND("TOP", ["A", "B"]), OR("B", ["A", "A"])]), ["E_DUP_ID"], []),
    "E_PROB_RANGE__above-one": (doc("TOP", {"A": 1.2, "B": 0.2}, [AND("TOP", ["A", "B"])]), ["E_PROB_RANGE"], []),
    "E_PROB_RANGE__negative": (doc("TOP", {"A": -0.1, "B": 0.2}, [AND("TOP", ["A", "B"])]), ["E_PROB_RANGE"], []),
    "E_PROB_RANGE__string": (mod(base, lambda d: d["events"][0].update(probability="0.1")), ["E_PROB_RANGE"], []),
    "E_PROB_RANGE__boolean": (mod(base, lambda d: d["events"][0].update(probability=True)), ["E_PROB_RANGE"], []),
    "E_NO_TOP__unknown-id": (mod(base, lambda d: d.update(top="NOPE")), ["E_NO_TOP"], []),
    "E_NO_TOP__missing": (mod(base, lambda d: d.pop("top")), ["E_NO_TOP"], []),
    "E_NO_TOP__not-a-string": (mod(base, lambda d: d.update(top=5)), ["E_NO_TOP"], []),
    "E_MISSING_REF__gate-input": (doc("TOP", ab, [AND("TOP", ["A", "ZZ"]), OR("G", ["A", "B"])]) | {"gates": [{"id": "TOP", "type": "and", "inputs": ["A", "B", "ZZ"]}]}, ["E_MISSING_REF"], []),
    "E_CYCLE__two-gates": (doc("TOP", {"A": 0.1, "B": 0.2}, [OR("TOP", ["B", "G2"]), AND("G2", ["A", "TOP"])]), ["E_CYCLE"], []),
    "E_CYCLE__self": (doc("TOP", {"A": 0.1}, [OR("TOP", ["TOP", "A"])]), ["E_CYCLE"], []),
    "E_GATE_ARITY__and-one-input": (doc("TOP", {"S": 0.05, "P1": 0.1}, [OR("TOP", ["S", "PUMPS"]), AND("PUMPS", ["P1"])]), ["E_GATE_ARITY"], []),
    "E_GATE_ARITY__or-no-inputs": (doc("TOP", {"A": 0.1, "B": 0.2}, [AND("TOP", ["A", "B", "G"]), OR("G", [])]), ["E_GATE_ARITY"], []),
    "E_VOTE_RANGE__k-1": (doc("V", three, [VOTE("V", ["A", "B", "C"], 1)]), ["E_VOTE_RANGE"], []),
    "E_VOTE_RANGE__k-equals-n": (doc("V", three, [VOTE("V", ["A", "B", "C"], 3)]), ["E_VOTE_RANGE"], []),
    "E_VOTE_RANGE__missing": (doc("V", three, [VOTE("V", ["A", "B", "C"], None)]), ["E_VOTE_RANGE"], []),
    "E_VOTE_RANGE__non-integer": (doc("V", three, [VOTE("V", ["A", "B", "C"], 2.5)]), ["E_VOTE_RANGE"], []),
    "E_VOTE_DUP__repeated-input": (doc("V", three, [VOTE("V", ["A", "A", "B", "C"], 2)]), ["E_VOTE_DUP"], []),
}
# the missing-ref and arity fixtures above contain an extra unused gate in their doc() call; rebuild them exactly
bad["E_MISSING_REF__gate-input"] = (doc("TOP", ab, [AND("TOP", ["A", "B", "ZZ"])]), ["E_MISSING_REF"], [])
bad["E_GATE_ARITY__or-no-inputs"] = (doc("TOP", {"A": 0.1, "B": 0.2}, [AND("TOP", ["A", "B", "G"]), OR("G", [])]), ["E_GATE_ARITY"], [])

expected = {}
for kind, group in (("good", good), ("bad", bad)):
    d = HERE / kind
    d.mkdir(exist_ok=True)
    for old in d.glob("*.json"):
        old.unlink()
    for name, (content, errs, warns) in group.items():
        text = content if isinstance(content, str) else json.dumps(content, indent=2)
        (d / f"{name}.json").write_text(text + "\n", encoding="utf-8", newline="\n")
        expected[f"{kind}/{name}.json"] = {"errors": sorted(errs), "warnings": sorted(warns)}
(HERE / "expected.json").write_text(json.dumps(expected, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
print(len(good), "good,", len(bad), "bad fixtures")
