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
| `maturity` | `candidate` \| `canonical` | Location: `blueprints/candidates/…` vs `blueprints/canonical/…` |
| `origin` | `native` \| `upstream-seed` \| `evolved` | How the blueprint came to exist |
| `lifecycle` | `active` \| `deprecated` \| `revoked` | Per version, in `lifecycle.yaml` (outside the seal) |

`COMPILED` is intentionally absent. See [LIFECYCLE.md](LIFECYCLE.md) for the four *provenance classes* derived from
`origin` and the transition rules.

## Repository layout of one version

```
blueprints/<maturity>/<id>/<version>/
  blueprint.yaml            the blueprint (schema/blueprint.schema.json)
  sanitisation-report.yaml  generalisation/privacy attestation, bound to blueprint.yaml by digest
  evals/suite.yaml          synthetic evaluation suite
  evals/results/*.yaml      evaluation results (canonical: at least one passing)
  lifecycle.yaml            append-only lifecycle history (only mutable file in a canonical dir)
  integrity.json            seal over every other file          (canonical only)
  promotion.yaml            promotion record and gates checked  (canonical only)
  submission.yaml           submission envelope, e.g. from Zep  (optional)
```

Canonical version directories are **immutable**: `check-immutability` (CI, against the PR base) rejects modifications,
deletions and additions, except appends to `lifecycle.yaml`. Fixing a canonical blueprint means publishing a new
version; retiring one means deprecating or revoking it.

## Tooling

`tools/` is small and layered so the provisional conventions stay swappable:

| Module | Responsibility |
|---|---|
| `ids.ts`, `schema/common.schema.json` | **Only** place that knows id / reference / digest / capability-name syntax |
| `layout.ts` | **Only** place that knows the on-disk layout (id used verbatim as directory name) |
| `validate.ts` | Schema + semantic rules + policy application |
| `scan.ts` | Privacy / no-concrete-config scanner (independent of the sanitisation report) |
| `integrity.ts` | Sealing/digests |
| `index-gen.ts` | Deterministic, timestamp-free index |
| `immutability.ts` | Git-based immutability enforcement |

Blueprint data refers to other registries with a **structured** reference
(`{registry, id, version, digest?}`), never a parsed string, so the serialisation can change without touching data
semantics.

## AgentGit-inspired principles (no dependency)

[Agent-Git](https://github.com/MAS-Infra-Layer/Agent-Git) models sessions, checkpoints and non-destructive branching,
and undoes tool effects by reversal or compensation. We take the *vocabulary and invariants*, not the implementation
(no AgentGit, LangGraph or SQLite dependency anywhere):

| AgentGit idea | Used here as |
|---|---|
| Append-only trajectories; branch on divergence, never rewrite | Canonical dirs immutable; evolution = new version with `lineage` (`provenance.evolution.parents`) |
| Checkpoints as addressable state | Evidence references may point at `checkpoint`/`trajectory`/`tape`/`session` handles (external) |
| Tool effect reversal / compensation | Every capability declares `effect: reversible \| compensable \| irreversible`; irreversible ⇒ approval required, compensable ⇒ compensation described, `securityClassification.maxEffect` bounds all |
| Reproducibility | Content digests, sealed versions, synthetic evaluation suites bound to the blueprint by digest |

Raw sessions, tapes and trajectories **never** enter Git; only opaque, provisional references do.

## Upstream seeds

Hugging Face Tiny Agents are launch configs (`agent.json`: model, provider, inputs, MCP servers), not blueprints.
Ingestion is specified in [`ingestion/SPEC.md`](../ingestion/SPEC.md) and **not implemented**; nothing is imported,
and seeds are never trusted or canonical by default.
