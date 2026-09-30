# Blueprint schema (`registry.zeptly.dev/v1alpha1`, kind `TinyAgentBlueprint`)

Authoritative: [`schema/blueprint.schema.json`](../schema/blueprint.schema.json). Semantic rules JSON Schema cannot
express live in `tools/src/validate.ts`. Envelope fields follow Registry Protocol v0.1
([PROTOCOL-ALIGNMENT.md](PROTOCOL-ALIGNMENT.md)); everything under `spec` is Tiny-Agent-specific.

## Common envelope

| Field | Purpose |
|---|---|
| `metadata.id`, `.version`, `.registry` | Logical identity (registry is always `tiny-agents`; id grammar `^[a-z0-9]+([.-][a-z0-9]+)*$`); independent of directory layout |
| `metadata.maturity` | `candidate` \| `canonical` |
| `metadata.origin` | `{type: native \| upstream-seed \| evolved, evolution?: {kind: discovered \| refined, sourceRefs}}` |
| `metadata.synthetic` | Local extension: fabricated example content (never in a production root) |
| `references` | Structured `{registry, id, version, digest?}`; must equal the refs used in `spec` |
| `provenance` | `createdAt`, `authors`, `sourceRefs` (registry refs or `{upstream:{source,path,revision}}`), `transformations` (`normalisation`, `clustering`, …) |
| `security` | `classification`, `capabilities` (`{capability, effect}`), `approvals` (governance approval records; excluded from the digest) |
| `attestations` | `{type, ref, subjectDigest, outcome?}`, digest-bound; see below |

`lifecycle` is deliberately **not** in `metadata`: it is the append-only overlay `lifecycle.yaml`.

## `spec` (Tiny Agent semantics)

| Field | Purpose |
|---|---|
| `descriptor` | name, description, `taskClass`, labels |
| `intent` | Resolution signature: summary, `appliesWhen`, `doesNotApplyWhen` |
| `interface` | Expected inputs (with `trust`) and outputs |
| **`procedure`** | Reusable ordered steps; may reference `{{slot.<name>}}` and capability/skill keys |
| **`slots`** | The only places task-specific values are bound at compile time; values are never stored here |
| **`adaptation`** | `mayAlter` (operations + bounds), `mustPreserve` (invariants), `locked` (reasons) |
| `skills` | Skill Blueprint *references* (never inlined) |
| `capabilities` | **Abstract** requirements with effect class (`reversible`/`compensable`/`irreversible`), operations, approval, compensation |
| `effects` | `maxEffect` bound and `egress` |
| `modelPolicy`, `contextPolicy`, `executionConstraints` | Abstract model requirements, memory/untrusted-input handling, limits |
| `lineage` | Exactly one of `native{rationale}` / `seed{licence, securityValidation}` / `recurrence{counts}` matching `origin.type` |
| `evaluation` | Suite path and `minPassRate` gate |
| `compatibility` | Runtime contract version |

## Adaptation contract

Every **step, slot, skill and capability** is classified exactly once as `mayAlter`, `mustPreserve` or `locked`.
`security`, `interface` and `evaluation` may never be `mayAlter`; `security` must be `locked`: the compiler and
runtime must not elevate or silently alter the declared security classification.

## Attestations and digests

`attestations[].subjectDigest` must equal the artifact's current content digest, so editing content invalidates every
attestation until it is redone. `sanitisation` and `evaluation` attestations reference in-directory documents
(`file:<path>`) that themselves carry `subjectDigest`; `security-review` and `recurrence` use opaque `evidence://…`
pointers (the full Evidence Protocol is deferred). See PROTOCOL-ALIGNMENT.md for the digest definition.

## Forbidden in registry content

Executable commands, infrastructure endpoints/URLs, credentials, concrete provider/MCP server configuration, concrete
model IDs, workspace/tenant identifiers, and any raw runtime payload (tapes, trajectories, sessions).
