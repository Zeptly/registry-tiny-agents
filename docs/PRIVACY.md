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
4. **Evidence by reference.** Raw sessions, tapes and trajectories stay outside Git. `attestations[]` carry only
   `{type, ref, subjectDigest, outcome?}`; `evidence://…` refs must be pseudonymous handles minted for promotion, not raw
   tenant or session identifiers (the full Evidence Protocol is deferred). Only files matching the policy filename allow-list are read
   (anything else is rejected unread); files above the size caps, symbolic links and non-LF/non-UTF-8 files are rejected;
   and transcript/trace/tape structures are detected, so tapes and payload dumps cannot be committed.
5. **Synthetic evaluation.** Eval suites must declare `dataProvenance: synthetic`.
6. **Sanitisation attestation.** Each version carries a `sanitisation` attestation pointing at `sanitisation-report.yaml`: which
   detectors ran, that generalisation happened, bound to the artifact's exact content digest. Stale reports fail validation. The report is an
   *attestation*, never a substitute for step 7.
7. **Independent scanner.** `registry validate` scans every key and value (and YAML comments and Markdown) of every
   file in every version directory for: forbidden keys (`command`, `args`, `env`, `url`, `provider`, `model`,
   `workspaceId`, …), URLs, IPs, emails, secrets/tokens/keys, executable commands, concrete model IDs, workspace-like
   identifiers and UUIDs. Matched text is never echoed. Unknown file types are rejected. Exemptions are per
   detector *and* per JSON path, in policy.

   **Transcript detection is contextual.** A conversation turn is an object with a conversation role
   (`user`, `assistant`, `system`, `tool`, `function`, `human`, `ai`, `developer`) in a `role`/`from`/`speaker` field
   **and** a message-content sibling (`content`, `text`, `message`, `parts`, `value`, `tool_calls`, …); arrays of
   `role: text` strings and multi-line transcript text are also detected. An array of objects that merely carry a
   `role` field — `spec.skills[]`, `security.approvals[]`, `promotion.yaml` reviewers — is **not** a transcript, so
   multiple skills, approvals and reviewers validate.

   **Failures are diagnostics, not crashes.** Invalid YAML/JSON, duplicate keys, lone surrogates, non-finite or
   unsafe numbers and unsupported values produce a file/path diagnostic; such a file is reported once, never scanned,
   loaded, hashed or indexed, and the run fails.

   **Scanner cost.** Every pattern is bounded so scan time is linear in input size. The pattern that was quadratic
   before the bound was added was `concrete-model-id` (566 / 2153 / 8300 ms at 20k / 40k / 80k characters); the
   `email` pattern was not the slow one. A regression test feeds inputs at the file-size cap with a fixed time ceiling.
8. **Human review.** Promotion requires reviewers by class, including a `privacy` role for evolved blueprints. Nothing
   is auto-merged.
9. **Root purpose.** A `production` root rejects synthetic content and placeholder identities; an `example` root
   requires them.

## Detectors are heuristics

They reduce risk; they do not prove absence of tenant data. Reviewers remain responsible for free text.
Improving detectors is a policy/PR change (`policy/registry-policy.yaml`).
