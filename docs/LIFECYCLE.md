# Lifecycle, provenance classes and versioning (PROVISIONAL)

## State

* `maturity`: `candidate` → `canonical`. Promotion is a PR that moves the version directory from
  `blueprints/candidates/` to `blueprints/canonical/` (new, sealed, ≥ 1.0.0) and adds `promotion.yaml`.
* `origin`: `native` (deliberately designed), `upstream-seed` (normalised from an upstream catalogue), `evolved`
  (produced by evidence-driven evolution).
* `lifecycle`: `active` → `deprecated` → `revoked` (also `active` → `revoked`); revoked is terminal. Recorded as
  an append-only history in `lifecycle.yaml`, the only file in a canonical directory that may change. A
  withdrawn candidate is `revoked`.
* **`COMPILED` is not a registry state.** Ad-hoc compilation happens in the runtime and leaves no registry object.

## Provenance classes

The four kinds of candidate the architecture must distinguish. The class is *derived* (never authored) from
`origin` and, for `evolved`, `provenance.evolution.kind`:

| Class | Derivation | Meaning | Recurrence evidence |
|---|---|---|---|
| `native` | `origin: native` | Deliberately designed | **Not required** — a designed blueprint may exist from day one |
| `upstream-seed` | `origin: upstream-seed` | Normalised from an upstream catalogue; untrusted until evaluated | Not required; licence + security gates instead |
| `discovered` | `origin: evolved`, `evolution.kind: discovered` | New pattern clustered from cross-workspace recurrence | Required (policy default) |
| `refined` | `origin: evolved`, `evolution.kind: refined` | Evolution of an existing blueprint (`parents` required, canonical) | Required (policy default) |

Requirements are **policy**, in `policy/registry-policy.yaml`, applied at two points:

* **admission** — what a candidate needs to exist in the registry (e.g. discovered: recurrence);
* **promotion** — what a canonical release needs (evals, reviewers and roles, licence/security for seeds, recurrence).

The Wisdom-of-Compute default is `minDistinctWorkspaces: 3`, `minExecutions: 10`. It is a *default policy
threshold*, not an architectural invariant: classes opt in with `recurrence: default`, or set their own values, or
`none`. Only aggregate counts are ever recorded — never workspace identifiers.

## Versioning (SemVer; change classification PROVISIONAL)

* Canonical versions are ≥ `1.0.0`, not prerelease, immutable directories.
* A candidate with no canonical release is `0.y.z`; a candidate of an existing id must be greater than every canonical
  version of that id (an evolved proposal, e.g. `1.1.0`).
* Working classification: **MAJOR** = contract change (interface, capabilities, effects, security classification);
  **MINOR** = procedure/slot/adaptation improvement; **PATCH** = wording/metadata. Unreconciled — see
  [CROSS-REGISTRY-RECONCILIATION.md](CROSS-REGISTRY-RECONCILIATION.md).
* The same `id@version` cannot exist as both candidate and canonical.

## Promotion workflow

1. Author or receive a candidate (`blueprints/candidates/<id>/<version>/`) via PR — human or Zep
   ([ZEP-SUBMISSION.md](ZEP-SUBMISSION.md)).
2. CI validates schema, semantics, privacy scan, attestations, admission policy.
3. Evaluate; add results under `evals/results/`.
4. Promotion PR: `git mv` the directory into `blueprints/canonical/`, set `maturity: canonical`, bump to a
   canonical version, add `promotion.yaml`, run `registry seal`, regenerate the index.
5. Required reviewers (per class policy) approve; nothing is auto-merged, including for Zep.
6. After merge the directory is immutable.
