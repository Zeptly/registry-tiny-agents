# Runtime contract (informative)

The future `Zeptly/runtime-trigger` implements a **generic** Tiny Agent compiler/executor on Trigger.dev. There are
**not** N static Trigger.dev tasks — one per blueprint.

```
task → resolve blueprint (index) → blueprint adapted within `adaptation` │ fresh compilation
     → runtime expression → generic Tiny executor → execution → evidence → disposal
```

What the runtime may rely on from this registry:

* the deterministic index (`index/registry-index.json`) for resolution by task class/intent/capabilities;
* immutable canonical versions addressed by `id@version` + content `digest` (and `sealDigest` for directory integrity);
* the resolver (`tools/src/resolve.ts`): declared range → exact version → content digest → **runtime lock**
  (`schema/runtime-lock.schema.json`), which the runtime records in its execution evidence. Ranges resolve to active
  canonical versions only. The lock has a `subject` and one entry per declared reference; references that cannot be
  resolved (for example no peer index supplied) appear as `status: unresolved` with a reason code, never omitted.
  Reason codes: `no-peer-index`, `not-found`, `no-eligible-version`, `digest-mismatch`, and the registry-**local**
  `invalid-range` (the range is not in the supported subset: exact, `^`, `~`, `x/*` partials, `>= > <= < =` glued to a
  version, space = AND, `||` = OR). A valid but unsatisfiable range is `no-eligible-version`, never `invalid-range`;
* **domain isolation** (registry-local): every resolution runs in exactly one domain — `production` (default) or
  `example` (only when requested explicitly, `--domain example`). Every supplied index must declare a matching
  `purpose` and a boolean `synthetic` on every entry, consistent with it; otherwise resolution fails with a
  `DomainError` (`domain-mismatch`, `missing-domain-metadata` or `conflicting-domain-metadata`) — the CLI prints the
  error as JSON on stderr and exits 2 — before any lock is produced. An ID prefix is never the only guard. `lock`
  also cross-checks the root's `registry.yaml` purpose against its index. The lock itself carries no domain marker
  (unresolved foreign references are still listed explicitly); CLI exit statuses: 0 all resolved, 1 any unresolved,
  2 input/usage/domain error;
* the adaptation contract (`mayAlter` / `mustPreserve` / `locked`) as the compiler's boundary;
* abstract capabilities and model policy, which the runtime maps to concrete tools/models it controls;
* effect classes, approval and compensation declarations for governing execution;
* the `security` envelope, which the compiler/runtime must not elevate or silently alter.

What the registry never provides: running agents, credentials, endpoints, concrete MCP commands or model IDs.
The runtime, not the registry, records execution evidence.
