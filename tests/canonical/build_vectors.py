"""Writes vectors.json. Number cases are hand-written from RFC 8785 examples/rules, not generated.
Model hashes are produced here once, then must be reproduced by check_vectors.cjs (independent)."""
import json
from canon import model_hash, document_hash

NUMBERS = [  # (JSON number text or marker, canonical text per RFC 8785 / ECMAScript)
    (0.1, "0.1"), (1e-1, "0.1"), (1, "1"), (0, "0"), ("neg-zero", "0"), (0.5, "0.5"),
    (0.021025, "0.021025"), (0.0595, "0.0595"), (0.029701, "0.029701"),
    (1e-6, "0.000001"), (1e-7, "1e-7"), (4.76837e-07, "4.76837e-7"), (1.5e-10, "1.5e-10"),
    (5e-324, "5e-324"), (0.30000000000000004, "0.30000000000000004"),
    (1e21, "1e+21"), (1.2345678901234568e20, "123456789012345680000"),
]

BASE = {
    "schema": {"id": "sneed.fault-tree", "version": 1},
    "assumptions": {"probability_model": "constant", "independence": "declared-independent", "coherence": "coherent", "time": "none"},
    "top": "TOP",
    "events": {"P1": {"probability": 0.1, "name": "Pump 1"}, "P2": {"probability": 0.1, "name": "Pump 2"}, "S": {"probability": 0.05, "name": "Power"}},
    "gates": {"TOP": {"type": "or", "inputs": ["S", "PUMPS"]}, "PUMPS": {"type": "and", "inputs": ["P1", "P2"]}},
    "layout": {"TOP": [0, 0]},
}


def to_array_doc(d):
    d = json.loads(json.dumps(d))
    d["events"] = [{"id": k, **v} for k, v in d["events"].items()]
    d["gates"] = [{"id": k, **v} for k, v in d["gates"].items()]
    return d


def variant(**edits):
    d = json.loads(json.dumps(BASE))
    for path, val in edits.items():
        keys = path.split("/")
        t = d
        for k in keys[:-1]:
            t = t[k]
        if val is DELETE:
            del t[keys[-1]]
        else:
            t[keys[-1]] = val
    return d


DELETE = object()
cases = [
    ("base", BASE, None),
    ("reordered-inputs", variant(**{"gates/TOP/inputs": ["PUMPS", "S"], "gates/PUMPS/inputs": ["P2", "P1"]}), "same"),
    ("layout-name-unknown-field", variant(**{"layout": {"TOP": [99, 99]}, "events/P1/name": "Renamed", "x-unknown": {"k": 1}}), "same"),
    ("probability-changed", variant(**{"events/S/probability": 0.06}), "differs"),
    ("gate-type-swapped", variant(**{"gates/PUMPS/type": "or"}), "differs"),
    ("assumptions-changed", variant(**{"assumptions/independence": "dependent"}), "differs"),
    ("top-changed", variant(top="PUMPS"), "differs"),
    ("unreachable-gate-added", variant(**{"gates/ORPHAN": {"type": "and", "inputs": ["P1", "S"]}}), "differs"),
    ("duplicate-input-retained", variant(**{"gates/PUMPS/inputs": ["P1", "P1", "P2"]}), "differs"),
    ("schema-version-changed", variant(**{"schema/version": 2}), "differs"),
]
# numeric spelling: same parsed value, different text. Built from raw text below.
model_cases = []
for cid, doc, rel in cases:
    doc = to_array_doc(doc)
    text = json.dumps(doc, indent=2)
    model_cases.append({"id": cid, "relation_to_base": rel, "document_json": text, "model_hash": model_hash(doc), "document_hash": document_hash(text.encode("utf-8"))})
spell = json.dumps(to_array_doc(BASE), indent=1).replace('"probability": 0.1', '"probability": 1e-1')
assert spell != json.dumps(to_array_doc(BASE), indent=1)
model_cases.append({"id": "numeric-spelling-1e-1", "relation_to_base": "same", "document_json": spell, "model_hash": model_hash(json.loads(spell)), "document_hash": document_hash(spell.encode())})
single = {"schema": BASE["schema"], "assumptions": BASE["assumptions"], "top": "P", "events": [{"id": "P", "probability": 0.1}], "gates": []}
model_cases.append({"id": "single-basic-event-top", "relation_to_base": "differs", "document_json": json.dumps(single), "model_hash": model_hash(single), "document_hash": document_hash(json.dumps(single).encode())})

vote_doc = {"schema": BASE["schema"], "assumptions": BASE["assumptions"], "top": "V",
            "events": [{"id": n, "probability": 0.1} for n in ("A", "B", "C")],
            "gates": [{"id": "V", "type": "atleast", "threshold": 2, "inputs": ["C", "A", "B"]}]}
model_cases.append({"id": "voting-2-of-3", "relation_to_base": "differs", "document_json": json.dumps(vote_doc), "model_hash": model_hash(vote_doc), "document_hash": document_hash(json.dumps(vote_doc).encode())})
vote3 = json.loads(json.dumps(vote_doc)); vote3["gates"][0]["threshold"] = 3
model_cases.append({"id": "voting-threshold-changed", "relation_to_base": "differs", "document_json": json.dumps(vote3), "model_hash": model_hash(vote3), "document_hash": document_hash(json.dumps(vote3).encode())})

dup_event = to_array_doc(BASE); dup_event["events"].append({"id": "P1", "probability": 0.2})
dup_gate = to_array_doc(BASE); dup_gate["gates"].append({"id": "PUMPS", "type": "or", "inputs": ["P1", "P2"]})
clash = to_array_doc(BASE); clash["gates"].append({"id": "S", "type": "or", "inputs": ["P1", "P2"]})
refusal_cases = [{"id": n, "document_json": json.dumps(d), "error": "E_DUP_ID"} for n, d in
                 (("duplicate-event-id", dup_event), ("duplicate-gate-id", dup_gate), ("event-gate-namespace-clash", clash))]
id_cases = [{"id": i, "valid": v} for i, v in [
    ("A", True), ("P1", True), ("_P", True), ("P_1", True), ("P-1", True), ("a", True), ("x" * 64, True),
    ("1A", False), ("-P", False), ("P-", False), ("P.1", False), ("P 1", False), ("", False), ("x" * 65, False), ("Pump\u00e9", False)]]

# common-cause groups (plan 15): the group is part of what the model means; its name and the order of its members are not
def group_doc(**edits):
    d = to_array_doc(BASE)
    d["assumptions"] = dict(BASE["assumptions"], independence="beta-factor-groups")
    d["common_cause_groups"] = [{"id": "G", "name": "Pump pair", "method": "beta-factor", "members": ["P1", "P2"], "beta": 0.1}]
    for k, v in edits.items():
        d[k] = v
    return d


def group_case(cid, d, **rel):
    text = json.dumps(d, indent=2)
    model_cases.append({"id": cid, "relation_to_base": rel.pop("base", "differs"), **rel, "document_json": text, "model_hash": model_hash(d), "document_hash": document_hash(text.encode("utf-8"))})


group_case("groups-base", group_doc())
g = group_doc(); g["common_cause_groups"][0]["members"] = ["P2", "P1"]
group_case("groups-member-order", g, same_as="groups-base")
g = group_doc(); g["common_cause_groups"][0].update(name="Renamed", **{"x-note": "kept"})
group_case("groups-name-and-unknown-field", g, same_as="groups-base")
g = group_doc(); g["common_cause_groups"][0]["beta"] = 0.2
group_case("groups-beta-changed", g, differs_from="groups-base")
g = group_doc(); g["common_cause_groups"][0]["id"] = "H"
group_case("groups-id-renamed", g, differs_from="groups-base")
g = group_doc(); g["common_cause_groups"][0]["members"] = ["P1", "S"]
group_case("groups-members-changed", g, differs_from="groups-base")
g = to_array_doc(BASE); g["common_cause_groups"] = []
group_case("groups-empty-list-keeps-hash", g, base="same")
dup_group = group_doc(); dup_group["common_cause_groups"].append(dict(dup_group["common_cause_groups"][0]))
group_clash = group_doc(); group_clash["common_cause_groups"][0]["id"] = "P1"
refusal_cases += [{"id": n, "document_json": json.dumps(d), "error": "E_DUP_ID"} for n, d in (("duplicate-group-id", dup_group), ("group-event-namespace-clash", group_clash))]

# an id of __proto__ is valid and must count (it once dropped out of the hash in the JavaScript implementations)
def proto_case(cid, d, **rel):
    text = json.dumps(d, indent=2)
    model_cases.append({"id": cid, "relation_to_base": "differs", **rel, "document_json": text, "model_hash": model_hash(d), "document_hash": document_hash(text.encode("utf-8"))})


pe = to_array_doc(BASE); pe["events"].append({"id": "__proto__", "probability": 0.25}); pe["gates"][0]["inputs"].append("__proto__")
proto_case("proto-event-base", pe, differs_from="base")
pe2 = json.loads(json.dumps(pe)); pe2["events"][-1]["probability"] = 0.5
proto_case("proto-event-probability-changed", pe2, differs_from="proto-event-base")
pg = to_array_doc(BASE); pg["gates"].append({"id": "__proto__", "type": "or", "inputs": ["P1", "P2"]}); pg["gates"][0]["inputs"].append("__proto__")
proto_case("proto-gate-base", pg, differs_from="base")
pg2 = json.loads(json.dumps(pg)); pg2["gates"][-1]["type"] = "and"
proto_case("proto-gate-type-changed", pg2, differs_from="proto-gate-base")
pc = group_doc(); pc["common_cause_groups"][0]["id"] = "__proto__"
proto_case("proto-group-base", pc, differs_from="groups-base")
pc2 = json.loads(json.dumps(pc)); pc2["common_cause_groups"][0]["beta"] = 0.2
proto_case("proto-group-beta-changed", pc2, differs_from="proto-group-base")

out = {"serializer": "RFC 8785 (JCS) subset; IDs per canon.ID_PATTERN", "projection": "plan 01 model identity", "number_cases": [{"value": v, "canonical": c} for v, c in NUMBERS], "model_cases": model_cases, "refusal_cases": refusal_cases, "id_cases": id_cases}
open("vectors.json", "w", newline="\n").write(json.dumps(out, indent=1) + "\n")
print(len(NUMBERS), "number cases,", len(model_cases), "model cases")
