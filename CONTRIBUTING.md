# Contributing

All changes are PRs. Git is the governance mechanism; registry state lives in files.

## Rules of thumb

* Never add tenant/workspace data, credentials, endpoints, concrete MCP commands or model IDs (see docs/PRIVACY.md).
* Never edit files in a published `blueprints/canonical/<id>/<version>/` (except appending to `lifecycle.yaml`).
  Publish a new version instead.
* Example content is SYNTHETIC and lives only under `examples/registry/`.
* Identity comes from `metadata.*`, never from directory names. Cross-registry references are structured objects, never strings.
* Attestations bind to the artifact **content digest**: any content edit makes them stale (`registry validate` fails).

## Adding or changing a candidate

1. Create/edit a candidate version directory (files listed in docs/ARCHITECTURE.md).
2. Refresh attestation `subjectDigest`s after any content change (`metadata.version`, `metadata.maturity` and `attestations` do not affect the digest).
3. `npm run index` then `npm run check`.

## Promoting

See "Promotion workflow" in docs/LIFECYCLE.md. Reviewers required by the class policy must approve; do not merge on
your own PR.

## Changing policy

Edit `policy/registry-policy.yaml`; bump `policyVersion`. Thresholds are policy, not code.

## Governance identities

`.github/CODEOWNERS` currently contains **placeholders only** (commented out). Real owners/teams must be configured
authoritatively before enforcement.
