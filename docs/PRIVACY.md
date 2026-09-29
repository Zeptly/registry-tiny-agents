# Tenant privacy and generalisation

**Workspace identifiers and tenant-specific content must never enter this registry.** Learning across workspaces
generalises *procedure*, not tenant data. Private customer names, private prompts, credentials, proprietary data and
workspace facts must not become global blueprint content. Workspace-private blueprints do not live here at all.

## Defence in depth

1. **Scope.** This repository is global only.
2. **Structure.** The schema is closed (`additionalProperties: false`). Free text is confined to declared
   procedure/description/slot fields; task-specific values belong in slots and are bound at compile time.
   Slot defaults must be generic.
3. **Aggregates only.** Recurrence is recorded as counts (`distinctWorkspaceCount`, `executionCount`,
   observation window). Workspace identifiers are never recorded — not even hashed.
4. **Evidence by reference.** Raw sessions, tapes and trajectories stay outside Git. `provenance.evidence[]` carries
   only `{kind, ref, digest?, outcome}`; `ref` must be a pseudonymous handle minted for promotion, not a raw tenant or
   session identifier (exact protocol PROVISIONAL).
5. **Synthetic evaluation.** Eval suites must declare `dataProvenance: synthetic`.
6. **Sanitisation report.** Each version carries `sanitisation-report.yaml`: which detectors ran, that generalisation
   happened, and the digest of the exact `blueprint.yaml` it attests. Stale reports fail validation. The report is an
   *attestation*, never a substitute for step 7.
7. **Independent scanner.** `registry validate` scans every key and value (and YAML comments and Markdown) of every
   file in every version directory for: forbidden keys (`command`, `args`, `env`, `url`, `provider`, `model`,
   `workspaceId`, …), URLs, IPs, emails, secrets/tokens/keys, executable commands, concrete model IDs, workspace-like
   identifiers and UUIDs. Matched text is never echoed. Unknown file types are rejected. Exemptions are per
   detector *and* per JSON path, in policy.
8. **Human review.** Promotion requires reviewers by class, including a `privacy` role for evolved blueprints. Nothing
   is auto-merged.
9. **Root purpose.** A `production` root rejects synthetic content and placeholder identities; an `example` root
   requires them.

## Detectors are heuristics

They reduce risk; they do not prove absence of tenant data. Reviewers remain responsible for free text.
Improving detectors is a policy/PR change (`policy/registry-policy.yaml`).
