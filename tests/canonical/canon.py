"""Canonical model_hash, Python implementation (plan 01). Serializer: RFC 8785 (JCS) subset.

Subset: objects, arrays, strings, finite numbers, booleans. IDs match ID_PATTERN (ASCII, so
key ordering by code point equals ordering by UTF-16 code unit). Independent of the
Node implementation in check_vectors.cjs; vectors.json is the shared contract.
"""
import hashlib
import json
import math
from decimal import Decimal

ID_PATTERN = r"^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$"  # SCRAM-compatible, see docs/spike/README.md


def es_number(x):
    """ECMAScript Number::toString (RFC 8785 section 3.2.2.3) for a finite float."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise TypeError("not a number")
    x = float(x)
    if not math.isfinite(x):
        raise ValueError("non-finite number refused")
    if x == 0:
        return "0"  # also covers negative zero
    sign = "-" if x < 0 else ""
    d = Decimal(repr(abs(x)))  # shortest round-trip digits
    digits = "".join(str(t) for t in d.as_tuple().digits).rstrip("0") or "0"
    n = d.adjusted() + 1  # decimal point position: value = 0.DIGITS * 10^n
    k = len(digits)
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es
    return sign + s


def canon(v):
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canon(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canon(i) for i in v) + "]"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return es_number(v)


def _by_id(items, kind):
    out = {}
    for item in items:
        if item["id"] in out:
            raise ValueError(f"E_DUP_ID {kind} {item['id']}")  # refused before hashing
        out[item["id"]] = item
    return out


def projection(doc):
    """Semantic projection of a native document (plan 01 'Model identity and provenance').
    events and gates are arrays of objects with an `id` (so duplicates are detectable)."""
    events_by_id = _by_id(doc["events"], "event")
    gates_by_id = _by_id(doc["gates"], "gate")
    if set(events_by_id) & set(gates_by_id):
        raise ValueError("E_DUP_ID event/gate namespace clash")
    gates = {}
    for gid, g in gates_by_id.items():
        entry = {"type": g["type"], "inputs": sorted(g["inputs"])}  # duplicates retained
        if "threshold" in g:
            entry["threshold"] = g["threshold"]
        gates[gid] = entry
    out = {
        "schema": {"id": doc["schema"]["id"], "version": doc["schema"]["version"]},
        "assumptions": doc["assumptions"],
        "top": doc["top"],
        "events": {eid: e["probability"] for eid, e in events_by_id.items()},
        "gates": gates,
    }
    # common-cause groups (plan 15): present only when the list is not empty, so a model without groups keeps its hash
    groups_by_id = _by_id(doc.get("common_cause_groups", []), "group")
    if set(groups_by_id) & (set(events_by_id) | set(gates_by_id)):
        raise ValueError("E_DUP_ID group/event namespace clash")
    if groups_by_id:
        out["common_cause_groups"] = {gid: {"method": g["method"], "members": sorted(g["members"]), "beta": g["beta"]} for gid, g in groups_by_id.items()}
    return out


def model_hash(doc):
    return hashlib.sha256(canon(projection(doc)).encode("utf-8")).hexdigest()


def document_hash(raw_bytes):
    return hashlib.sha256(raw_bytes).hexdigest()
