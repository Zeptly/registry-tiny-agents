# PROVISIONAL conventions and where they are isolated

The Skills, Execution Agent and QB registries have independently proposed different conventions. All will be
reconciled into a common **Zeptly Registry Protocol** before any registry PR is merged. Until then this repository
avoids spreading assumptions.

| Convention | Current (provisional) form | Isolated in |
|---|---|---|
| Blueprint id | `^[a-z0-9]+([._-][a-z0-9]+)*$`, ≤128; **no internal structure is meaningful** (`example.*` ids are only examples) | `schema/common.schema.json#registryId`, `tools/src/ids.ts` |
| Cross-registry reference | Structured `{registry, id, version(range), digest?}`; display string `registry-<registry>:<id>@<range>[#digest]` | `common.schema.json#registryRef`, `ids.ts` (`formatRef`/`parseRef`) |
| Version-directory layout | `blueprints/<maturity>/<id>/<version>/`, id verbatim | `tools/src/layout.ts` |
| Digest / seal | `sha256:<hex>`; seal = sha256 over sorted `path\0filehash\n` | `common.schema.json#digest`, `tools/src/integrity.ts` |
| Evidence reference | `{kind, ref, digest?, outcome}` with opaque pseudonymous `ref` | `blueprint.schema.json#evidenceRef` |
| Capability names | dotted lower-case (`document.read`) | `common.schema.json#capabilityName` |
| Index | `tiny-agent-registry-index/v0-provisional` | `tools/src/index-gen.ts` |
| Vocabulary | maturity/origin/lifecycle, provenance classes | `blueprint.schema.json`, `tools/src/validate.ts` |
| Thresholds | recurrence default 3/10, reviewer counts | `policy/registry-policy.yaml` (policy, not code) |

Every schema `apiVersion`/`*Version` carries `v0-provisional`.

To migrate an id/reference format: change the pattern and helpers above, rewrite data with a codemod, regenerate
indexes. No other module parses ids.
