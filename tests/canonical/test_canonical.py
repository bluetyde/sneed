"""Python-side checks of vectors.json plus the verifier-must-fail tests (plan 05)."""
import json
import math
import subprocess
import sys
from canon import canon, model_hash, es_number

vec = json.load(open("vectors.json"))
bad = 0
for c in vec["number_cases"]:
    v = -0.0 if c["value"] == "neg-zero" else c["value"]
    if canon(v) != c["canonical"]:
        bad += 1; print("NUMBER FAIL", c["value"], canon(v), c["canonical"])
base = next(m for m in vec["model_cases"] if m["id"] == "base")["model_hash"]
for m in vec["model_cases"]:
    got = model_hash(json.loads(m["document_json"]))
    if got != m["model_hash"]:
        bad += 1; print("HASH FAIL", m["id"])
    rel = m["relation_to_base"]
    if rel == "same" and m["model_hash"] != base:
        bad += 1; print("RELATION FAIL (should be same)", m["id"])
    if rel == "differs" and m["model_hash"] == base:
        bad += 1; print("RELATION FAIL (should differ)", m["id"])
by_id = {m["id"]: m["model_hash"] for m in vec["model_cases"]}
for m in vec["model_cases"]:
    if m.get("same_as") and m["model_hash"] != by_id[m["same_as"]]:
        bad += 1; print("RELATION FAIL (should equal", m["same_as"], ")", m["id"])
    if m.get("differs_from") and m["model_hash"] == by_id[m["differs_from"]]:
        bad += 1; print("RELATION FAIL (should differ from", m["differs_from"], ")", m["id"])
# same model hash but saved-document hash differs for metadata-only edits
lay = next(m for m in vec["model_cases"] if m["id"] == "layout-name-unknown-field")
b = next(m for m in vec["model_cases"] if m["id"] == "base")
if lay["document_hash"] == b["document_hash"]:
    bad += 1; print("document_hash should differ for layout edit")
import re
from canon import ID_PATTERN
for c in vec["id_cases"]:
    if bool(re.match(ID_PATTERN, c["id"])) != c["valid"]:
        bad += 1; print("ID FAIL", repr(c["id"]))
for c in vec["refusal_cases"]:
    try:
        model_hash(json.loads(c["document_json"])); bad += 1; print("REFUSAL NOT RAISED", c["id"])
    except ValueError as e:
        if c["error"] not in str(e):
            bad += 1; print("WRONG ERROR", c["id"], e)
# non-finite refused
for v in (math.nan, math.inf, -math.inf):
    try:
        es_number(v); bad += 1; print("non-finite accepted", v)
    except ValueError:
        pass
# verifier must be able to fail: a deliberately wrong serializer (plain json.dumps) disagrees on a vector
if json.dumps(1e-7) == "1e-7" or json.dumps(1e-6) == "0.000001":
    bad += 1; print("sanity: plain json.dumps unexpectedly matches JCS; the vectors would not detect it")
print(f"python: failures={bad}")
sys.exit(1 if bad else 0)
