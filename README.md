# registry-tiny-agents

Canonical Zeptly registry of **Tiny Agent Blueprints**.

> **The registry does not store running Tiny Agents.** Executions are ephemeral: task-compiled → instantiated →
> executed → evidence captured → disposed. **Blueprints persist.** A blueprint is a reusable *construction
> pattern* (a known-good prior the compiler adapts), not an immutable agent.

**Status: foundation / candidate architecture.** Every identifier, reference, digest, evidence and index convention
here is **PROVISIONAL** pending cross-registry reconciliation into a common Zeptly Registry Protocol. See
[`docs/PROVISIONAL.md`](docs/PROVISIONAL.md) and [`docs/CROSS-REGISTRY-RECONCILIATION.md`](docs/CROSS-REGISTRY-RECONCILIATION.md).

## Where things are

| Path | Purpose |
|---|---|
| `schema/` | JSON Schemas (2020-12) for blueprints, evals, sanitisation reports, submissions, lifecycle, policy, … |
| `policy/registry-policy.yaml` | Governance thresholds/gates per provenance class, privacy detectors. **Policy, not code.** |
| `blueprints/candidates/<id>/<version>/` | Candidate registry objects (mutable only through PRs) — empty for now |
| `blueprints/canonical/<id>/<version>/` | Immutable canonical version directories — empty for now |
| `upstreams/` | Upstream source descriptors + locks (Hugging Face: **specified only, nothing imported**) |
| `ingestion/SPEC.md` | Specification of the future upstream-ingestion pipeline |
| `examples/registry/` | A **SYNTHETIC** example registry root (3 blueprints) that proves the architecture and drives tests |
| `tools/` | TypeScript validator, privacy scanner, sealer, deterministic index generator, immutability check |
| `docs/` | Architecture, lifecycle, privacy, schema, Zep submission contract, runtime contract |

The real registry root (`.`) is deliberately empty. Example content lives only under `examples/registry/`, and
the validator enforces that synthetic content and placeholder identities can never appear in a production root.

## Commands

```sh
npm ci
npm run check           # typecheck + tests + validate both roots + index freshness
npm run validate        # validate ./ (production) and examples/registry
npm run index           # regenerate index/registry-index.json for both roots
npx tsx tools/src/cli.ts seal <version-dir>            # write integrity.json
npx tsx tools/src/cli.ts check-immutability --base origin/main
```

## Read next

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) → [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md) →
[`docs/PRIVACY.md`](docs/PRIVACY.md) → [`CONTRIBUTING.md`](CONTRIBUTING.md).
