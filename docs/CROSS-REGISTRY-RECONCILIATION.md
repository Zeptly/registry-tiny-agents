# Cross-registry reconciliation status

Reconciliation target: **Zeptly Registry Protocol v0.1** (approved baseline). See
[PROTOCOL-ALIGNMENT.md](PROTOCOL-ALIGNMENT.md) for the implementation mapping and the interpretations that need
confirmation.

| # | Item | Status |
|---|---|---|
| 1 | Universal registry ID | **Normalized**: logical identity is `metadata.id` (+ `metadata.registry`); shared lowercase dotted/hyphenated grammar `^[a-z0-9]+([.-][a-z0-9]+)*$`, no registry prefix; decoupled from layout |
| 2 | Cross-registry reference format | **Settled**: structured `{registry, id, version, digest?}` |
| 3 | Version-directory convention | **Registry-local**: protocol does not mandate; layout isolated in `tools/src/layout.ts`, discovery by index `location` |
| 4 | Candidate representation | **Settled**: candidates are registry objects; Git is governance transport |
| 5 | maturity/origin/lifecycle vocabulary | **Settled** for fields and independence; `origin.type` adds `upstream-seed`, lifecycle overlay stays outside `metadata` (see alignment doc) |
| 6 | Evidence-reference protocol | **Deferred** by protocol; attestations carry opaque pointers only |
| 7 | Index format/publication | **Fields settled**; peer-index distribution/publication deferred |
| 8 | Provenance schema | **Envelope settled** (`createdAt/authors/sourceRefs/transformations`); item shapes registry-local |
| 9 | Digest/sealing convention | **Normalized**: artifact digest (excludes version, maturity, lifecycle, attestations, governance approvals) plus a separate directory seal; canonical JSON, code-point ordering, LF policy and golden vectors in [CANONICALIZATION.md](CANONICALIZATION.md) |
| 10 | SemVer change classification | **Open**: SemVer required; MAJOR/MINOR/PATCH classification remains local (docs/LIFECYCLE.md) |
| 11 | Shared capability/tool/gateway namespaces | **Deferred** by protocol |
| 12 | Shared evaluation-result format | **Open**: attestation type `evaluation` settled; result document format registry-local |
