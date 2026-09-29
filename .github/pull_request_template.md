## Summary

<!-- What changes and why -->

## Registry change type

- [ ] Tooling / schema / policy / docs
- [ ] New or changed candidate (`blueprints/candidates/…`)
- [ ] Promotion to canonical (`blueprints/canonical/…`)
- [ ] Lifecycle change (deprecate / revoke)
- [ ] Upstream source / ingestion specification

## Privacy and provenance checklist

- [ ] No workspace identifiers, tenant content, credentials, endpoints, concrete MCP commands or model IDs
- [ ] Sanitisation report present and bound to the current `blueprint.yaml` digest
- [ ] Evidence is by reference only; no raw sessions/tapes/trajectories
- [ ] Any example content is unmistakably SYNTHETIC
- [ ] Published canonical directories untouched (except `lifecycle.yaml` appends)

## Validation

- [ ] `npm run check` passes

## Cross-Registry Reconciliation Required

<!-- List any provisional convention this PR touches; see docs/CROSS-REGISTRY-RECONCILIATION.md -->
