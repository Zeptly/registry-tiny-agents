# Canonicalization, digests and line endings — `zeptly-jcs-v1`

One contract, used everywhere digests are computed (Zeptly Registry Protocol v0.2 §2–§5). The language-neutral vectors
in [`vectors/zeptly-jcs-v1.json`](../vectors/zeptly-jcs-v1.json) pin every rule below. Their JCS, digest and seal values
are produced and re-verified by an **independent stdlib-only Python implementation**
([`vectors/zeptly_jcs_v1.py`](../vectors/zeptly_jcs_v1.py), run in CI as `npm run vectors`); the TypeScript harness
(`tools/tests/vectors.test.ts`) runs the same file, plus the parser and lock vectors. An implementation is conformant
only if it reproduces every vector. A change to any rule below requires a **new `digestAlgorithm` identifier and new
vectors**.

The identifier `zeptly-jcs-v1` is carried by every index, index entry, seal (`integrity.json`), lock, and every reference
that pins a digest (`registryRef.digestAlgorithm`, required whenever `digest` is non-null).

## Manifest input (`tools/src/manifest.ts`)

The authoritative input of every blueprint, evaluation suite/result, sanitisation report, promotion, lifecycle, submission
and upstream YAML (and of the JSON files) is a **JSON-compatible YAML subset**, parsed by `parseManifestBytes`:

| Rule | Diagnostic code |
|---|---|
| UTF-8 only; no BOM; no NUL; no CR / CRLF (rejected, never normalised) | `invalid-utf8`, `bom`, `nul`, `carriage-return` |
| exactly one document; non-empty; the root is a mapping | `multiple-documents`, `empty-document`, `unsupported-type` |
| mapping keys are strings; duplicate keys rejected (with their JSON path) | `non-string-key`, `duplicate-key` |
| anchors, aliases and merge keys (`<<`) rejected (a quoted `"<<"` is an ordinary key) | `anchor`, `alias`, `merge-key` |
| only core tags `!!str !!int !!float !!bool !!null !!map !!seq` (anything else, e.g. `!!binary`, `!!timestamp`, `!!set`, `!custom`) | `unsupported-tag` |
| YAML 1.2 core semantics: timestamps stay strings; `yes`/`no`/`on`/`off` are strings unless typed | — |
| numbers are JSON decimal literals (no hex, octal, leading zeros, `+`, `.5`, `5.`) | `unsupported-number-syntax` |
| `NaN`, `±Infinity`, `.inf`, `.nan`, literals that overflow to infinity | `non-finite-number` |
| integer-valued numbers with \|n\| > 2^53 − 1 (covers long literals, `9007199254740993.0`, `9.007199254740993e15`, `1e21`) | `unsafe-integer` |
| lone surrogates in strings or keys (`"\ud800"`); encoded surrogates are invalid UTF-8 | `lone-surrogate`, `invalid-utf8` |
| unsupported types, cycles, nesting deeper than 64 (defence in depth for in-memory values) | `unsupported-type`, `circular-reference`, `too-deep` |
| JSON files: strict `JSON.parse` first, then the same subset checks (duplicate keys!) | `invalid-json` |

A failing document is **never returned**, so it cannot be validated, hashed, indexed or sealed. Every problem is a
structured diagnostic `{code, path, line?, column?, message}` — the validator exposes them on `Diagnostic`
(`code`, `path`, `line`, `column`) — and **never** an uncaught exception. Exit code `2` (see below).

## Canonical JSON = RFC 8785 JCS (`tools/src/jcs.ts`)

Applied to the parsed value:

* object keys sorted by **UTF-16 code units** (`compareUtf16`); arrays keep their order;
* strings escaped as RFC 8785 §3.2.2.2 / ECMAScript `JSON.stringify`, emitted as UTF-8; no Unicode normalisation (NFC and
  NFD spellings stay distinct);
* numbers as ECMAScript Number-to-string (`1.0` → `1`, `1e21` → `1e+21`, `-0` → `0`); non-finite numbers rejected;
* unsupported values (`undefined`, `bigint`, `Date`, `Map`, …) and lone surrogates throw;
* **no line-ending rewriting inside parsed manifest values** (a string value containing `\r\n` hashes as authored).

This **replaces** the registry-local code-point key order of the previous draft. The two differ only for characters
outside the BMP versus U+E000–U+FFFF (e.g. the keys U+FB01 / U+10000 / U+E000 are covered by vectors); digests of
documents with only BMP-ordered ASCII keys are unchanged, which is why the example artifact digests did not move.

## Artifact digest (`contentDigest`)

`sha256:` + hex of SHA-256 over `JCS(projection)` where the projection is an explicit **allow-list**:

* **included**: `apiVersion`, `kind`, `metadata.{id, registry, origin, synthetic}`, `spec`, `references`, `provenance`
  (the manifest's history and external sources), `security.{classification, capabilities}`;
* **excluded**: `metadata.version`, `metadata.maturity`, lifecycle (an overlay file, never part of the manifest),
  `attestations`, `security.approvals` (governance approval records).

Runtime approval requirements live in `spec.capabilities[].approval` and therefore **do** change the digest. Governance
approvals, attestations, promotion records and reports bind to the digest through `subjectDigest` but never affect it.
Because the projection is an allow-list, a field added to the envelope later is excluded until the contract is
deliberately versioned. `contentDigest` validates the value domain first and throws `CanonicalizationError` (with JSON
paths) instead of hashing.

## Directory seal (`computeSeal`, `integrity.json`; canonical versions)

```
seal = sha256(JCS({ registry, id, version, payload: [{ path, sha256 }] }))
```

`payload[]` lists every **permitted payload file** — regular files matching `policy/registry-policy.yaml`
`files.payload` (here only `evals/suite.yaml`, the evaluation suite the manifest references) — with its SHA-256 (bare
lowercase hex), ordered by normalised POSIX path in **code-point order**. The manifest is represented by the artifact
digest; lifecycle, `integrity.json`, promotion, submission, sanitisation report and evaluation results are mutable /
evidence / approval / seal records and are **not** payload (they are bound by `subjectDigest`, and the Git immutability
check still refuses any change to published canonical content other than appending lifecycle history).

`integrity.json` (`schema/integrity.schema.json`, `integrity/v0.2`) records `{integrityVersion, digestAlgorithm, registry,
id, version, digest, payload[]}`. Before hashing, the seal rejects symlinks, FIFOs/sockets/devices, **case-colliding
paths**, files outside the allow-list, and payload files that are not UTF-8 / BOM-free / LF-only
(`SealInputError`: `case-collision`, `bom`, `nul`, `carriage-return`, `invalid-utf8`).

## Line endings and encoding (`tools/src/textpolicy.ts`)

Every text file must be **UTF-8, no BOM, LF-only (no CR), no NUL**. `.gitattributes` forces `eol=lf` on checkout and
`registry validate` rejects violations, so seals are byte-identical on every platform. Payload bytes are hashed exactly as
validated; nothing is ever normalised.

## Ordering is two separate rules

* **JSON canonicalization** (digests): keys by UTF-16 code unit (`compareUtf16`).
* **Indexes, paths, seal payload, capability lists**: explicit Unicode **code-point** order (`compareCodePoints`); index
  entries sort by `id`, then SemVer precedence, then digest. Never `localeCompare`.

## Diagnostics and exit codes

`0` success · `1` a **valid request that cannot be satisfied** (an unresolved reference; the lock says `complete: false`)
· `2` malformed input or any validation error (manifest subset violations, schema/semantic errors, stale index,
immutability violation, privacy finding, domain error, unreadable file).
