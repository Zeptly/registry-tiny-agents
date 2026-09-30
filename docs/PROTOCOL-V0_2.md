# Zeptly Registry Protocol v0.2 adoption (Tiny Agents registry)

Final algorithm identifier: **`zeptly-jcs-v1`**. Source: the *Zeptly Registry Protocol v0.2 Amendment* (status: draft for
review). This registry adopts it on the draft branch; nothing here is published from `main`, so regenerating the
unpublished example ledger is permitted (amendment §11). Once content is published, a digest change needs a new version
and a migration protocol.

| Amendment § | Requirement | Implementation | Checked by |
|---|---|---|---|
| 1 Envelope | one evolution-kind location; shared origin vocabulary | schema accepts `native \| upstream-seed \| discovered \| refined \| evolved` and kinds `discovered \| refined \| generalised`; this registry's validator uses `native`, `upstream-seed`, `evolved` with kind `discovered` or `refined` | `v02.test.ts` |
| 2 Manifest input | JSON-compatible YAML subset, exit 2 | `tools/src/manifest.ts`; used for **every** YAML/JSON file (blueprint, suite, results, report, promotion, lifecycle, submission, upstream source/lock, registry marker, index, policy) | parser vectors, `remediation.test.ts`, `v02.test.ts` |
| 3 Canonicalization | RFC 8785 JCS | `tools/src/jcs.ts` (UTF-16 key order); LF/UTF-8/no-BOM policy; nothing normalised | JCS vectors (+ Python) |
| 4 Hash contract | artifact digest, directory seal, `digestAlgorithm` | `tools/src/integrity.ts`; `integrity.json` `integrity/v0.2`; `policy files.payload`; case-collision/symlink/special-file rejection | digest + seal vectors (+ Python), tests |
| 5 Vectors | language-neutral, all cases | `vectors/zeptly-jcs-v1.json`, `vectors/zeptly_jcs_v1.py`, `tools/tests/vectors.test.ts` | CI |
| 6 References and locks | RuntimeLock shape and rules | `schema/runtime-lock.schema.json`, `tools/src/resolve.ts` | lock vectors, `remediation.test.ts` |
| 7 Evaluation / approvals | suite-bound evaluation attestations; governance vs runtime approval | attestation `{type: evaluation, suite{id,version,digest}, result, subjectDigest, ref}`; suite files carry `id`/`version`; promotion needs a passing, suite-and-subject-bound result | `v02.test.ts` |
| 8 Index | fields, ordering | `tools/src/index-gen.ts`, `schema/index.schema.json` (`domain`, `digestAlgorithm`, per-entry too) | `index --check` |
| 9 Diagnostics | no uncaught exceptions, exit 2 vs 1, codes, populated-baseline immutability | `Diagnostic{code,path,line,column}`; CLI exit codes; `check-immutability` against a populated base | `v02.test.ts`, CI |
| 10 Synthetic | domain, marker, namespace, pointers, never referenced by production | registry marker `domain: synthetic`; `example.` namespace; `evidence://synthetic/`; production artifacts referencing `example.*` ids are errors | tests |

## What changed in the artifacts

* `digestAlgorithm: zeptly-jcs-v1` on indexes, index entries, seals, locks, and pinned references
  (`registryRef.digestAlgorithm` is required when `digest` is non-null — including `evolution.sourceRefs`).
* **Domain vocabulary**: root marker, index and lock use `domain: production | synthetic` (previously `purpose:
  production | example`); resolver option and CLI flag `--domain synthetic`; index entries no longer carry a boolean
  `synthetic` but a `domain`.
* **Artifact digest** of the synthetic example is **unchanged** (`sha256:7c953f60…78ea`): the new projection equals the
  old exclusion list for every existing field and all example keys are BMP-ordered. **Seals changed** by design (new
  formula, payload selection).
* Example fixtures were regenerated on this draft branch: evaluation suites gained `id`/`version`, the evaluation
  attestation has the v0.2 shape, the aliased `references` entry was expanded (aliases are not in the subset), and
  `integrity.json` has the new shape.
* Digest pins are verified against the **selected** entry (highest eligible version) rather than narrowing the set.

## Documented deviations and local extensions

1. **`metadata.lifecycle` is not stored in the manifest.** The amendment's envelope sketch lists it, but lifecycle is an
   append-only overlay (`lifecycle.yaml`), exactly as the amendment's own digest rule treats it ("lifecycle overlays" are
   excluded). The index carries the *effective* lifecycle.
2. **Seal payload is only `evals/suite.yaml`** (policy `files.payload`). This registry's other version-directory files are
   the manifest (represented by the artifact digest) or mutable/evidence/approval/seal records.
3. Registry-local `invalid-range` unresolved code (shared code list not yet specified); local `integrity/v0.2` seal record
   format; local `promotion.yaml`, `submission.yaml`, report and result formats.
4. The v0.2 origin vocabulary is accepted by the schema, but `discovered`/`refined` as an *origin type* and `generalised`
   as an evolution kind are rejected by this registry's validator (they are evolution kinds here).

## Adoption test (§13)

1. Shared vectors: `npm run vectors` (Python) and `tools/tests/vectors.test.ts` (TypeScript).
2. Registry-local tests: `npm test`.
3. Generated indexes and locks validate against their schemas (`index --check`, lock tests).
4. Populated-baseline immutability: `tools/tests/v02.test.ts` and `registry.test.ts` run `check-immutability` against a
   populated Git base (not only an empty `main`).
5. Peer-index fixtures: **no real peer registry index exists yet**, so this registry cannot truthfully claim a
   real-peer resolution. The fixtures are a clearly labelled **synthetic** peer index (`skills`, domain `synthetic`) that
   resolves successfully, and an unresolved one (`no-peer-index`) that fails explicitly with `complete: false`, exit 1.
6. The draft PR description records `zeptly-jcs-v1` and the deferred protocols below.

## Deferred (separate contracts, not implemented here)

Evidence Protocol and runtime evidence records · capability/gateway/model namespace ownership · signatures and reviewer
authority · peer-index distribution · workspace overrides · traffic channels · nested execution · runtime-trigger contract
versioning · **transitive dependency resolution and cycle handling** · no runtime code is added.
