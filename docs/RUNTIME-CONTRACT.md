# Runtime contract (informative)

The future `Zeptly/runtime-trigger` implements a **generic** Tiny Agent compiler/executor on Trigger.dev. There are
**not** N static Trigger.dev tasks — one per blueprint.

```
task → resolve blueprint (index) → blueprint adapted within `adaptation` │ fresh compilation
     → runtime expression → generic Tiny executor → execution → evidence → disposal
```

What the runtime may rely on from this registry:

* the deterministic index (`index/registry-index.json`) for resolution by task class/intent/capabilities;
* immutable canonical versions addressed by `id@version` + artifact `digest` + `digestAlgorithm` (and `sealDigest` for directory integrity);
* the resolver (`tools/src/resolve.ts`): declared range → exact version → artifact digest → **RuntimeLock**
  (`schema/runtime-lock.schema.json`, Protocol v0.2 §6), which the runtime records in its execution evidence:

  ```yaml
  apiVersion: registry.zeptly.dev/v1alpha1
  kind: RuntimeLock
  digestAlgorithm: zeptly-jcs-v1
  domain: production        # production | synthetic
  subject: {registry: tiny-agents, id: ..., version: ..., digest: sha256:...}
  complete: false           # true only when every entry is resolved
  entries:                  # one per declared reference, in declaration order — never omitted
    - requested: {registry: skills, id: source-evaluation, version: "^1.0.0"}
      status: unresolved
      unresolved: {code: no-peer-index, message: peer index was not supplied}
  ```

  Rules: revoked versions never resolve (not even by exact pin); deprecated versions resolve only by exact pin;
  candidates need explicit opt-in (`--allow-candidates`); prereleases resolve only when the requested range names a
  prerelease; a digest pin must match the **selected** (highest eligible) index entry and carries its
  `digestAlgorithm`; only `zeptly-jcs-v1` indexes are accepted. Unresolved codes: `no-peer-index`, `not-found`,
  `no-eligible-version`, `digest-mismatch`, and the registry-**local** `invalid-range` (the range is not in the supported
  subset: exact, `^`, `~`, `x/*` partials, `>= > <= < =` glued to a version, space = AND, `||` = OR). A valid but
  unsatisfiable range is `no-eligible-version`, never `invalid-range`. **Transitive resolution and cycle detection are
  runtime responsibilities** until a later amendment; this registry resolves one level (the subject's declared references);
* **domain isolation** (Protocol v0.2 §6, §10): every resolution runs in exactly one domain — `production` (default) or
  `synthetic` (only when requested explicitly, `--domain synthetic`). Every supplied index must declare that `domain` and
  repeat it on every entry; production and synthetic indexes are never mixed (`mixed-domains`), and a production
  resolution can never consume the synthetic example index (`domain-mismatch`). Other `DomainError`s:
  `missing-domain-metadata`, `conflicting-domain-metadata`, `unsupported-digest-algorithm`. The CLI prints the error as
  JSON on stderr and exits 2 before any lock is produced. An ID prefix is never the only guard. `lock` also cross-checks
  the root's `registry.yaml` `domain` against its index. Exit statuses: 0 complete lock, 1 any unresolved reference
  (valid request that cannot be satisfied), 2 malformed input / usage / domain error;
* the adaptation contract (`mayAlter` / `mustPreserve` / `locked`) as the compiler's boundary;
* abstract capabilities and model policy, which the runtime maps to concrete tools/models it controls;
* effect classes, approval and compensation declarations for governing execution;
* the `security` envelope, which the compiler/runtime must not elevate or silently alter.

What the registry never provides: running agents, credentials, endpoints, concrete MCP commands or model IDs.
The runtime, not the registry, records execution evidence.
