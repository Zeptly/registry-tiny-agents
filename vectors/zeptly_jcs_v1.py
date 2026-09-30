#!/usr/bin/env python3
"""Independent (stdlib-only) reference implementation of the `zeptly-jcs-v1` contract for the JCS, artifact digest and
directory seal vectors in zeptly-jcs-v1.json (Zeptly Registry Protocol v0.2). It shares no code with the TypeScript tooling.

    python3 vectors/zeptly_jcs_v1.py verify     # recompute every expected value and compare (CI runs this)
    python3 vectors/zeptly_jcs_v1.py generate   # rewrite the computed fields of the vectors file

Parser and lock vectors are exercised by the TypeScript harness (tools/tests/vectors.test.ts); this script covers the
byte-exact parts that any implementation language must reproduce.
"""
import hashlib, json, math, os, sys
from decimal import Decimal

ALGORITHM = "zeptly-jcs-v1"
HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "zeptly-jcs-v1.json")


def es_number(x):
    """ECMAScript Number::toString for finite doubles (RFC 8785 section 3.2.2.3)."""
    if isinstance(x, bool):
        raise ValueError("bool is not a number")
    if isinstance(x, int):
        if abs(x) > 2**53 - 1:
            raise ValueError("unsafe integer")
        return str(x)
    if not math.isfinite(x):
        raise ValueError("non-finite number")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    d = Decimal(repr(abs(x)))
    t = d.as_tuple()
    digits = "".join(map(str, t.digits)).rstrip("0") or "0"
    n = len(t.digits) + t.exponent  # value = 0.digits * 10^n
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        body = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es
    return sign + body


_ESC = {0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0C: "\\f", 0x0D: "\\r", 0x22: '\\"', 0x5C: "\\\\"}


def es_string(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if 0xD800 <= c <= 0xDFFF:
            raise ValueError("lone surrogate")
        if c in _ESC:
            out.append(_ESC[c])
        elif c < 0x20:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def utf16_key(s):
    return s.encode("utf-16-be", "surrogatepass")


def jcs(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return es_number(v)
    if isinstance(v, str):
        return es_string(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(es_string(k) + ":" + jcs(v[k]) for k in sorted(v, key=utf16_key)) + "}"
    raise ValueError("unsupported value")


def sha256_hex(b):
    return hashlib.sha256(b).hexdigest()


def projection(doc):
    md = doc.get("metadata", {})
    sec = doc.get("security", {})
    out = {}
    for k in ("apiVersion", "kind"):
        if k in doc:
            out[k] = doc[k]
    out["metadata"] = {k: md[k] for k in ("id", "registry", "origin", "synthetic") if k in md}
    for k in ("spec", "references", "provenance"):
        if k in doc:
            out[k] = doc[k]
    out["security"] = {k: sec[k] for k in ("classification", "capabilities") if k in sec}
    return out


def artifact_digest(doc):
    return "sha256:" + sha256_hex(jcs(projection(doc)).encode("utf-8"))


def seal(registry, id_, version, files, payload_patterns):
    import re
    payload = []
    for path in sorted(files, key=lambda p: [ord(c) for c in p]):
        if any(re.search(p, path) for p in payload_patterns):
            payload.append({"path": path, "sha256": sha256_hex(files[path].encode("utf-8"))})
    digest = "sha256:" + sha256_hex(jcs({"registry": registry, "id": id_, "version": version, "payload": payload}).encode("utf-8"))
    return digest, payload


def main(mode):
    with open(VECTORS, encoding="utf-8") as f:
        data = json.load(f)
    assert data["digestAlgorithm"] == ALGORITHM
    bad = 0

    def check(name, got, want):
        nonlocal bad
        if mode == "verify" and got != want:
            bad += 1
            print("MISMATCH", name, "\n  got ", got, "\n  want", want)

    for v in data["jcs"]:
        v_out = jcs(json.loads(v["input"], parse_int=lambda t: int(t) if abs(int(t)) <= 2**53 - 1 else float(t)))
        if mode == "generate":
            v["output"] = v_out
        check("jcs/" + v["name"], v_out, v["output"])
    for v in data["digest"]["cases"]:
        d = artifact_digest(v["doc"])
        if mode == "generate":
            v["digest"] = d
        check("digest/" + v["name"], d, v["digest"])
        for same in v.get("sameDigest", []):
            check("digest/" + v["name"] + "/same/" + same["name"], artifact_digest(same["doc"]), d)
        for diff in v.get("differentDigest", []):
            check("digest/" + v["name"] + "/different/" + diff["name"], artifact_digest(diff["doc"]) != d, True)
    for v in data["seal"]["cases"]:
        who = v["subject"]
        digest, payload = seal(who["registry"], who["id"], who["version"], v["files"], data["seal"]["payloadPatterns"])
        if mode == "generate":
            v["payload"], v["seal"] = payload, digest
        check("seal/" + v["name"] + "/payload", payload, v["payload"])
        check("seal/" + v["name"], digest, v["seal"])
        for same in v.get("sameSeal", []):
            files = {**v["files"], **same["files"]}
            check("seal/" + v["name"] + "/same/" + same["name"], seal(who["registry"], who["id"], who["version"], files, data["seal"]["payloadPatterns"])[0], digest)
        for diff in v.get("differentSeal", []):
            s = diff.get("subject", who)
            files = {**v["files"], **diff.get("files", {})}
            for p in diff.get("remove", []):
                files.pop(p, None)
            check("seal/" + v["name"] + "/different/" + diff["name"], seal(s["registry"], s["id"], s["version"], files, data["seal"]["payloadPatterns"])[0] != digest, True)
    if mode == "generate":
        with open(VECTORS, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("generated", VECTORS)
        return 0
    print("vectors OK" if not bad else "%d vector mismatch(es)" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("verify", "generate"):
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
