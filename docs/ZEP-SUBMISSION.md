# Zep submission contract (PROVISIONAL)

Zep (the future evolutionary steward) is **not implemented here**. This document defines the governed interface it —
or any other author — uses to propose registry changes.

## Channel

A submission is a **Git PR** from a bot or human identity. Zep gets no direct write access to `main`, no bypass of
required checks and no auto-merge.

## Contents of a candidate submission PR

Adds `blueprints/candidates/<id>/<version>/` containing:

* `blueprint.yaml`, `sanitisation-report.yaml`, `evals/suite.yaml`, `lifecycle.yaml`;
* `submission.yaml` ([`schema/submission.schema.json`](../schema/submission.schema.json)): `submissionId`,
  `submitter {kind: zep|human|other-agent, identity}`, `action` (`propose-candidate` | `propose-revision` |
  `propose-promotion` | `propose-lifecycle-change`), `subject {id, version}`, `artifacts` (digests of blueprint,
  sanitisation report, eval suite), and mandatory attestations
  (`noWorkspaceIdentifiers`, `noTenantContent`, `rawEvidenceExcluded` — all `true`).

For discovered/refined candidates `provenance.evolution` carries aggregate recurrence counts and a clustering method
descriptor, and `provenance.evidence[]` carries external references. CI verifies that the submission digests match the
files, that admission policy for the class is met (e.g. recurrence ≥ policy threshold for `discovered`), and that the
privacy scan is clean.

## What Zep must NOT submit

Workspace identifiers, tenant data, raw sessions/tapes/trajectories, concrete tool commands/endpoints/credentials,
concrete model or provider configuration, non-synthetic evaluation inputs.

## Promotion

Promotion of a candidate is a separate PR (`propose-promotion`) that moves the directory, seals it and adds
`promotion.yaml`. Required human reviewers (by class policy) approve it.
