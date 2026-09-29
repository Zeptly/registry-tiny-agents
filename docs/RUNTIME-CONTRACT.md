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
  resolved (for example no peer index supplied) appear as `status: unresolved` with a reason code, never omitted;
* the adaptation contract (`mayAlter` / `mustPreserve` / `locked`) as the compiler's boundary;
* abstract capabilities and model policy, which the runtime maps to concrete tools/models it controls;
* effect classes, approval and compensation declarations for governing execution;
* the `security` envelope, which the compiler/runtime must not elevate or silently alter.

What the registry never provides: running agents, credentials, endpoints, concrete MCP commands or model IDs.
The runtime, not the registry, records execution evidence.
