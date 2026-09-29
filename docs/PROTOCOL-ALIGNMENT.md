# Alignment with Zeptly Registry Protocol v0.1

This registry implements the approved Protocol v0.1 baseline for the `tiny-agents` registry. Nothing here is inferred
from sibling registries. The protocol defines the common envelope; **`spec` stays Tiny-Agent-specific** (ephemeral
compilation, `procedure + slots + adaptation`, recurrence/generalisation semantics).

## Envelope

```yaml
apiVersion: registry.zeptly.dev/v1alpha1
kind: TinyAgentBlueprint
metadata: {id, version, registry: tiny-agents, origin: {type, evolution?}, maturity, synthetic}
spec: {...}            # tiny-agent semantics
references: []         # structured {registry, id, version, digest?}
provenance: {createdAt, authors, sourceRefs, transformations}
security: {classification, capabilities, approvals}
attestations: []       # digest-bound
```

## Normative rules → implementation

| Protocol rule | Implementation | Enforced by |
|---|---|---|
| Every artifact has `kind`, `metadata.id/version/registry` | `schema/blueprint.schema.json` | schema |
| Published versions immutable, addressed by exact digest | Sealed canonical dirs (`integrity.json`) + artifact `digest` in index/lock | `validate` (seal), `check-immutability` (Git base), resolver |
| Canonical = SemVer; candidate of existing identity must exceed all canonical | Version rules | `validate` |
| Candidates are registry objects; Git is transport | `blueprints/candidates/…` objects with `metadata.maturity: candidate` | `validate` (zone must match `maturity`) |
| `maturity`, `origin`, `lifecycle` independent | `metadata.maturity`, `metadata.origin`, `lifecycle.yaml` overlay; indexed separately | schema, index |
| Lifecycle append-only overlay | `lifecycle.yaml` (only mutable file in a canonical dir); transitions validated | `validate`, `check-immutability` |
| Structured cross-registry refs | `references[]`, `spec.skills[].ref`, `origin.evolution.sourceRefs` — objects, never strings | schema; `references` must equal the refs used in `spec` |
| Range → exact version + digest → runtime lock → evidence | `tools/src/resolve.ts`, `schema/runtime-lock.schema.json`, `registry resolve` / `registry lock` | tests; runtime records the lock in its own evidence |
| Attestations bind to the exact subject digest | `attestations[].subjectDigest`; attestation documents carry `subjectDigest` too | `validate` — stale digest = error |
| No raw tapes/trajectories in Git | Extension whitelist, per-file size cap, privacy scanner, external evidence pointers only | `validate` |
| Compiler/runtime must not alter security classification | `adaptation.locked` must include `security`; `security` is never `mayAlter` | `validate` |
| Deterministic index with identity, version, digest, maturity, lifecycle, origin, location | `index/registry-index.json`, no timestamps | `index --check` in CI |
| Promotion: schema, semantics, evals, provenance, security review, digest-bound attestations, approval | `policy/registry-policy.yaml` per provenance class; `promotion.yaml` | `validate` |
| Synthetic examples isolated and marked | `examples/registry/` root (`purpose: example`); `example.` id namespace; `synthetic: true`; `evidence://synthetic/…` | `validate`; production index schema forbids synthetic entries |

## Shared normalizations

* **Evolution kind** lives only at `metadata.origin.evolution.kind`. The index mirrors it as `origin.evolution.kind`;
  no derived class field is stored in artifacts, promotion records or the index.
* **ID grammar**: lowercase ASCII letters/digits in segments separated by single `.` or `-`
  (`^[a-z0-9]+([.-][a-z0-9]+)*$`, 3–128 characters), no registry-specific prefix. The `example.` prefix is the
  reserved synthetic namespace, not an ID convention for production.
* **Runtime lock** (`schema/runtime-lock.schema.json`): `subject` plus one ordered `entries[]` item per declared
  reference, each `status: resolved | unresolved`. Unresolved items carry a code (`no-peer-index`, `not-found`,
  `no-eligible-version`, `digest-mismatch`); foreign references are never omitted.
* **Content safety**: explicit filename allow-list (`policy files.allow`), per-file / per-directory / file-count limits,
  symbolic links and special files rejected and never followed, LF-only UTF-8, and tape/trace/transcript detection
  (forbidden keys, role-tagged turn structures, transcript text and opaque-blob patterns).

## Identity is decoupled from layout

`metadata.id` / `version` / `maturity` are authoritative. Directory names are not parsed into identity; consumers use
the index `location`. `tools/src/layout.ts` derives where artifacts are *created* (`idSegment` encodes any id safely for
the filesystem) and `validate` lints that artifacts sit there. Changing the layout means editing `layout.ts` only.

## Digests

* **Artifact `digest`** (index, references, locks) = SHA-256 of the canonical JSON of the blueprint. **Included:**
  identity, `spec`, `references`, `provenance`, `security.classification` and `security.capabilities`. **Excluded:**
  `metadata.version`, `metadata.maturity`, lifecycle (overlay file), `attestations` and `security.approvals`
  (governance approvals). Attestations cannot contain the digest of a document that contains them, and promotion must
  not invalidate evaluations of unchanged content.
* **`sealDigest`** (canonical only) = separate SHA-256 over the canonical payload files (every file in the version
  directory except `lifecycle.yaml` and `integrity.json`): tamper-evidence, checked by `validate` and the Git
  immutability check.
* Canonical JSON, code-point ordering and the LF-only line-ending policy are specified in
  [CANONICALIZATION.md](CANONICALIZATION.md) and pinned by golden vectors.
* Attestation documents (sanitisation report, evaluation result, promotion record, submission) carry `subjectDigest`
  and are rejected when stale.

## Interpretations made where the protocol is silent (flag for review)

1. **`metadata.lifecycle` is not stored.** The protocol envelope lists it, but lifecycle is an append-only overlay;
   a value inside immutable content would go stale on deprecation. Lifecycle is read from `lifecycle.yaml` and emitted in
   the index.
2. **Digest definition** as above (content digest vs directory seal).
3. **`security.approvals`** holds **governance approval records** (`{role, identity, subjectDigest}`), excluded from the
   artifact digest and digest-bound like attestations. For canonical versions they must mirror `promotion.yaml`
   reviewers; candidates carry none. Runtime approval *requirements* stay in `spec.capabilities[].approval`.
4. **`security.classification`** vocabulary: `public | internal | confidential | restricted` (superset of prior local
   values plus the protocol example `restricted`).
5. **`metadata.origin.type`** keeps `upstream-seed` alongside the protocol's `native`/`evolved`.
6. **`metadata.synthetic`** is a local extension for the synthetic-namespace rule.
7. **Attestation `type`** values: `sanitisation | evaluation | security-review | recurrence`; `sanitisation` and
   `evaluation` reference in-directory documents (`file:<path>`), the others opaque `evidence://…` pointers.
8. **`spec.*` fields** (adaptation contract, slots, effects, lineage/recurrence) are registry-specific by design.
9. **Registry-local policy**, not protocol: recurrence default (3 workspaces / 10 executions), reviewer counts, class
   promotion gates — all in `policy/registry-policy.yaml`.

## Deferred by the protocol (not implemented)

Evidence Protocol schema/ownership, capability/gateway/model namespaces, signing, peer-index distribution,
workspace overrides, traffic channels, nested QB execution, runtime-trigger contract versioning. The resolver accepts
whatever indexes the caller provides; it fetches nothing.
