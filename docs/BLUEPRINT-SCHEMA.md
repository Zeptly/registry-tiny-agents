# Blueprint schema (v0, PROVISIONAL)

Authoritative definition: [`schema/blueprint.schema.json`](../schema/blueprint.schema.json). Semantic rules that JSON
Schema cannot express live in `tools/src/validate.ts`.

| Field | Purpose |
|---|---|
| `apiVersion`, `kind` | Envelope; `tiny-agent-blueprint/v0-provisional` |
| `id`, `version` | Stable id (**PROVISIONAL syntax**) and SemVer |
| `maturity`, `origin` | Registry axes (lifecycle is in `lifecycle.yaml`) |
| `metadata` | name, description, `taskClass`, labels, maintainers, `synthetic` |
| `intent` | Resolution signature: summary, `appliesWhen`, `doesNotApplyWhen` |
| `interface` | Expected inputs (with `trust`) and outputs |
| **`procedure`** | Reusable ordered steps; may reference `{{slot.<name>}}` and capability/skill keys |
| **`slots`** | The only places task-specific values are bound at compile time; values are never stored here |
| **`adaptation`** | `mayAlter` (with operations + bounds), `mustPreserve` (invariants), `locked` (reasons) |
| `skills` | *References* to Skill Blueprints (structured `{registry,id,version,digest?}`); never inlined |
| `capabilities` | **Abstract** capability requirements with effect class, operations, approval, compensation |
| `modelPolicy` | Abstract requirements (tier, tool calling, modalities, context, cost/latency); no model IDs |
| `contextPolicy` | Memory (`none`\|`scratch-only`), untrusted input handling |
| `executionConstraints` | Step/tool/time/token/retry limits, `onLimit`, termination conditions |
| `securityClassification` | Data sensitivity, `maxEffect`, egress |
| `compatibility` | Runtime contract version |
| `provenance` | Authoring; exactly one of `native` / `upstream` / `evolution`; evidence references; sanitisation report |
| `evaluation` | Suite path, result paths, `minPassRate` gate |

## The adaptation contract

The future compiler may change a blueprint only within these bounds. Every **step, slot, skill and capability** must
be classified **exactly once**:

* `mayAlter` — target + permitted operations (`reword`, `reorder`, `insert-*`, `remove`, `bind`, `tighten`,
  `substitute-equivalent`) + textual bounds;
* `mustPreserve` — target + invariant that must still hold after adaptation;
* `locked` — target + reason; not to be touched.

`securityClassification`, `interface` and `evaluation` may never appear in `mayAlter`; `securityClassification`
must be `locked`. Slots must be referenced by the procedure, and every placeholder must resolve to a declared slot.

## What is forbidden in canonical (and enforced for all) blueprints

Executable commands, infrastructure endpoints/URLs, credentials, concrete provider/MCP server configuration,
concrete model IDs, workspace/tenant identifiers. Enforced by the schema (`additionalProperties: false`), a key
denylist and pattern detectors (see [PRIVACY.md](PRIVACY.md)).

## Beyond the original field list

Added: `slots`, `adaptation`, per-capability `effect`/`approval`/`compensation`, `securityClassification.maxEffect`,
input `trust`, `contextPolicy`, `executionConstraints.onLimit`, lineage (`evolution.parents`), `metadata.synthetic`,
a sealed integrity digest and a separate append-only lifecycle.
