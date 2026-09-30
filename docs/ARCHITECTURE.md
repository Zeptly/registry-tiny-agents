# Architecture

## Model

```
task ──► blueprint resolution ──► blueprint (adapt) │ fresh compilation
      ──► runtime expression ──► generic executor ──► execution ──► evidence ──► disposal
                                                          │
   Wisdom of Compute:  evidence ──► recurrence detection ──► clustering/generalisation
                       ──► candidate blueprint ──► evaluation ──► Git PR ──► canonical blueprint
```

* **Compilation is a runtime event**, owned by the future `Zeptly/runtime-trigger` architecture. It is *not* a
  registry state. If no suitable blueprint exists the runtime compiles a Tiny Agent from scratch; the registry never
  sees that agent, only (later) sanitised, aggregated evidence about recurring procedures.
* The registry stores **blueprints**: `procedure + slots + adaptation` plus capability/model/context/security
  requirements, provenance, evidence *references* and an evaluation suite.
* Git is the **governance mechanism**. Registry objects (candidates and canonical versions) are files; branches/PRs
  are how their state changes. A candidate is a registry object, not "a branch".

## Registry axes

| Axis | Values | Notes |
|---|---|---|
| `metadata.maturity` | `candidate` \| `canonical` | Zone: `blueprints/candidates/…` vs `blueprints/canonical/…` (zone must match the field) |
| `metadata.origin` | `native` \| `upstream-seed` \| `evolved` | How the blueprint came to exist |
| lifecycle | `active` \| `deprecated` \| `revoked` | Append-only overlay `lifecycle.yaml` (outside the seal) |

`COMPILED` is intentionally absent. See [LIFECYCLE.md](LIFECYCLE.md) for the four *provenance classes* derived from
`origin` and the transition rules.

## Repository layout of one version

```
blueprints/<candidates|canonical>/<segment(id)>/<version>/     (location derived by layout.ts; identity lives in the document)
  blueprint.yaml            the blueprint (schema/blueprint.schema.json); carries `attestations`
  sanitisation-report.yaml  generalisation/privacy attestation document, bound to the content digest
  evals/suite.yaml          synthetic evaluation suite
  evals/results/*.yaml      evaluation result documents (canonical: at least one passing attestation)
  lifecycle.yaml            append-only lifecycle history (only mutable file in a canonical dir)
  integrity.json            seal over the payload files         (canonical only)
  promotion.yaml            promotion record and gates checked  (canonical only)
  submission.yaml           submission envelope, e.g. from Zep  (optional)
```

Canonical version directories are **immutable**: `check-immutability` (CI, against the PR base) rejects modifications,
deletions and additions, except appends to `lifecycle.yaml`. Fixing a canonical blueprint means publishing a new
version; retiring one means deprecating or revoking it.

## Tooling

`tools/` is small and layered so serialisation conventions stay swappable:

| Module | Responsibility |
|---|---|
| `ids.ts`, `schema/common.schema.json` | Id / reference / digest / capability-name patterns |
| `layout.ts` | **Only** place that knows the on-disk layout; discovery never derives identity from paths |
| `validate.ts` | Schema + semantic rules + policy application |
| `scan.ts` | Privacy / no-concrete-config scanner (independent of the sanitisation report) |
| `integrity.ts` | Content digest and directory seal |
| `index-gen.ts` | Deterministic, timestamp-free index (identity, digest, maturity, lifecycle, origin, location) |
| `resolve.ts` | Range → exact version + digest → runtime lock (offline, index-driven) |
| `immutability.ts` | Git-based immutability enforcement |

Blueprint data refers to other registries with a **structured** reference (`{registry, id, version, digest?}`), never a
parsed string. References validate structurally with no cross-repository network access; references into this
registry are additionally checked against the local root.

## AgentGit-inspired principles (no dependency)

[Agent-Git](https://github.com/MAS-Infra-Layer/Agent-Git) models sessions, checkpoints and non-destructive branching,
and undoes tool effects by reversal or compensation. We take the *vocabulary and invariants*, not the implementation
(no AgentGit, LangGraph or SQLite dependency anywhere):

| AgentGit idea | Used here as |
|---|---|
| Append-only trajectories; branch on divergence, never rewrite | Canonical dirs immutable; evolution = new version with `lineage` (`metadata.origin.evolution.sourceRefs`) |
| Checkpoints as addressable state | Evidence references may point at `checkpoint`/`trajectory`/`tape`/`session` handles (external) |
| Tool effect reversal / compensation | Every capability declares `effect: reversible \| compensable \| irreversible`; irreversible ⇒ approval required, compensable ⇒ compensation described, `spec.effects.maxEffect` bounds all |
| Reproducibility | Content digests, sealed versions, synthetic evaluation suites bound to the blueprint by digest |

Raw sessions, tapes and trajectories **never** enter Git; only opaque evidence pointers do.

## Upstream seeds

Hugging Face Tiny Agents are launch configs (`agent.json`: model, provider, inputs, MCP servers), not blueprints.
Ingestion is specified in [`ingestion/SPEC.md`](../ingestion/SPEC.md) and **not implemented**; nothing is imported,
and seeds are never trusted or canonical by default.
