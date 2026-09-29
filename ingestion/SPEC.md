# Upstream ingestion specification (SPECIFICATION ONLY)

**Status: specification. No importer exists. Nothing has been imported. Upstream seeds are never trusted or
canonical by default.** A bulk import requires explicit instruction after this architecture is reviewed.

## 1. Goal

Let appropriate upstream Tiny Agent definitions become **seed candidates** in this registry, with full provenance and
without importing risk:

```
upstream catalogue
  → fetch @ pinned revision → quarantine
  → licence / provenance check
  → security validation
  → schema normalisation (agent.json → blueprint skeleton)
  → duplication / quality / capability-compatibility checks
  → sanitisation report
  → seed candidate  (origin: upstream-seed, maturity: candidate)   ← opened as a Git PR
  → (later, separately) evaluation → human review → canonical
```

## 2. Hugging Face Tiny Agents — what the upstream actually is

Researched 2026-09-29 (details in `upstreams/huggingface-tiny-agents/source.yaml`):

* Catalogue: Hugging Face dataset `tiny-agents/tiny-agents` (Apache-2.0 declared at dataset level); at research time 9
  agent folders from 6 authors. Layout `<author>/<agent>/agent.json` + optional `PROMPT.md` | `AGENTS.md`,
  `README.md`, `EXAMPLES.md`. `data.parquet` is an auto-converted mirror.
* `agent.json`: `model`, `provider` **or** `endpointUrl`, `inputs[]` (`promptString`, `id`, `description`,
  `password`; referenced as `${input:id}`), `servers[]` (`stdio` | `http` | `sse`; `command`, `args`, `env`, `url`).
* Runtime: MCP tool loop (`@huggingface/tiny-agents`, MIT; Python `huggingface_hub`).
* Gaps versus a blueprint: no task class, IO contract, versioning, evaluations, effect classes, security
  classification, per-agent licence. They are launch **configs**, hence at best thin seeds.
* Hazards: `stdio` servers run arbitrary commands (`npx …@latest`, `docker run`, `mcp-remote`) with unpinned
  versions and credentials via args/env; hard-coded model/provider conflicts with abstract model policy.

## 3. Pipeline stages

| # | Stage | Input → output | Reject when |
|---|---|---|---|
| 0 | **Source descriptor** | `upstreams/<source>/source.yaml` + `lock.json` | source not registered, `ingestion.status` ≠ `enabled` |
| 1 | **Fetch** | pinned upstream revision → quarantine workspace (outside the registry tree) | unpinned revision, mutable ref |
| 2 | **Licence & provenance** | detect licence(s): dataset-level, per-agent, per-file, contributor statement | no SPDX-resolvable licence, licence incompatible with redistribution, unverifiable authorship. Dataset-level licence alone ⇒ `status: unverified` |
| 3 | **Security validation** | static analysis of `agent.json`/prompts | see §5 |
| 4 | **Normalisation** | `agent.json` + prompt → blueprint skeleton (§4) | cannot be expressed abstractly without embedding config |
| 5 | **Duplication** | normalised-procedure hash + capability set + intent similarity vs registry and prior seeds | duplicate of existing blueprint/seed ⇒ link as `alias`/skip, don't re-import |
| 6 | **Quality** | non-trivial prompt, coherent intent, examples present, no dead links | below quality bar |
| 7 | **Capability compatibility** | map each MCP server to abstract capability names; effect classification | capability unknown to shared namespace ⇒ mark unmapped; may reject |
| 8 | **Sanitisation** | scanner + report (privacy doc) | any finding |
| 9 | **Emit** | seed candidate dir + `provenance.upstream` + lock entry, opened as PR | validation failure |

The importer must be **idempotent** and produce deterministic output for a given `(source, revision)`.

## 4. Normalisation mapping (HF `agent.json` → blueprint)

| Upstream | Blueprint | Rule |
|---|---|---|
| `PROMPT.md` / `AGENTS.md` | `procedure.steps[]` + `intent` | Re-expressed as procedure; task-specific literals lifted into `slots`. Prompt text is data, scanned, never executed |
| `servers[]` | `capabilities[]` | **Dropped as config, retained as abstract need.** Command/args/url/env/headers are discarded; capability inferred from the server's *declared tool surface* (allowlisted mapping table, reviewed) |
| `inputs[]` (`promptString`) | *dropped* | Credentials are runtime-injected secrets; never modelled in blueprints |
| `model`, `provider`, `endpointUrl` | `modelPolicy` | Discarded; replaced with abstract requirements (`toolCalling: required`, tier chosen conservatively) |
| author/path/revision | `provenance.upstream` | `source`, `path`, `revision`, licence, `retrievedAt`, `normalisation {lossy, dropped, toolVersion}` |
| — | `adaptation` | Conservative default: everything `locked` until a human loosens it |
| — | `securityClassification` | Conservative default: strictest applicable, egress `declared-capabilities-only` |
| — | `evaluation` | Synthetic placeholder suite; seed cannot be promoted without passing evals |

Result: `origin: upstream-seed`, `maturity: candidate`, `provenance.upstream.licence.status: unverified`,
`securityValidation: not-run|passed|failed`.

## 5. Security validation (reject or flag)

* `stdio` servers whose command is not on an allowlist; any `@latest`/unpinned package; `docker run` with host mounts
  or `--privileged`; shell metacharacters; `mcp-remote` or similar proxies.
* Secrets in args/env/prompt; `${input:…}` credential plumbing.
* Remote (`http`/`sse`) servers on non-allowlisted hosts.
* Prompt-injection markers or instructions to exfiltrate.
* Tools with irreversible effects without an approval story.

Concrete tool wiring is a **runtime** decision; the registry never stores it.

## 6. Upstream synchronisation

* `lock.json` pins `pinnedRevision` and, per imported entry, `{path, revision, contentDigest, blueprint{id,version}}`.
* A scheduled job compares upstream HEAD with the lock and opens a **diff PR** for reviewed changes; it never
  auto-updates. Upstream deletion ⇒ flag for deprecation review, never delete.
* Upstream change to an already-seeded agent produces a **new seed candidate version**, not an in-place edit.
* Divergence is recorded: a seed that evolves locally keeps `provenance.upstream` and gains lineage.

## 7. Trust rules

* Seeds start `candidate`, `unverified`, never `canonical`.
* Promotion to canonical uses the `upstream-seed` policy: verified licence, passed security validation, passing
  evaluation, ≥ 2 human reviewers including security (see policy).
* Evolution from a seed into a locally improved blueprint is `origin: evolved` with lineage.

## 8. Not covered / open

Shared capability namespace, provenance schema and evaluation-result format are pending cross-registry
reconciliation; the mapping table (MCP tool surface → abstract capability) needs the shared namespace first.
