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
| 9 | Digest/sealing convention | **Normalized**: artifact digest (excludes version, maturity, lifecycle, attestations, governance approvals) plus a separate directory seal; **v0.2 adopted on this draft (`zeptly-jcs-v1`)**: RFC 8785 JCS, JSON-compatible YAML subset, artifact digest projection, directory seal over payload files, language-neutral vectors — see [CANONICALIZATION.md](CANONICALIZATION.md) and [PROTOCOL-V0_2.md](PROTOCOL-V0_2.md) |
| 10 | SemVer change classification | **Open**: SemVer required; MAJOR/MINOR/PATCH classification remains local (docs/LIFECYCLE.md) |
| 11 | Shared capability/tool/gateway namespaces | **Deferred** by protocol |
| 12 | Shared evaluation-result format | **Open**: attestation type `evaluation` settled; result document format registry-local |

## Registry-local repairs awaiting the shared specification

These were fixed locally (PR #1) and are **not** shared conventions; each needs a decision in the shared contract:

* the `invalid-range` lock code, the supported range subset, and whether malformed ranges are a lock entry or an error;
* the domain-isolation rules (single resolution domain, `DomainError` codes, exit status 2) and whether a lock should
  carry a domain marker;
* the numeric/value policy for digests (safe-integer limit, rejection of non-finite/unsupported values) and the YAML
  scalar profile (YAML 1.2 core: hex/octal integers), which must match across registries for digests to agree;
* the transcript/tape/trace detector vocabulary;
* resolver digest re-verification at resolution time, a lock completeness indicator, optional references,
  transitive resolution and cycle handling (all unchanged and still open).
