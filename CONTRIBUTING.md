# Contributing

All changes are PRs. Git is the governance mechanism; registry state lives in files.

## Rules of thumb

* Never add tenant/workspace data, credentials, endpoints, concrete MCP commands or model IDs (see docs/PRIVACY.md).
* Never edit files in a published `blueprints/canonical/<id>/<version>/` (except appending to `lifecycle.yaml`).
  Publish a new version instead.
* Example content is SYNTHETIC and lives only under `examples/registry/`.
* Id/reference/digest/evidence syntax is PROVISIONAL — don't build on it beyond `tools/src/ids.ts`.

## Adding or changing a candidate

1. Create/edit `blueprints/candidates/<id>/<version>/` (files listed in docs/ARCHITECTURE.md).
2. `npm run registry -- digest <file>` to bind digests in the sanitisation report / submission.
3. `npm run check` (regenerates nothing; run `npm run index` first to update the index).

## Promoting

See "Promotion workflow" in docs/LIFECYCLE.md. Reviewers required by the class policy must approve; do not merge on
your own PR.

## Changing policy

Edit `policy/registry-policy.yaml`; bump `policyVersion`. Thresholds are policy, not code.

## Governance identities

`.github/CODEOWNERS` currently contains **placeholders only** (commented out). Real owners/teams must be configured
authoritatively before enforcement.
