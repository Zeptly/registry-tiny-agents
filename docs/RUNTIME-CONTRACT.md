# Runtime contract (informative, PROVISIONAL)

The future `Zeptly/runtime-trigger` implements a **generic** Tiny Agent compiler/executor on Trigger.dev. There are
**not** N static Trigger.dev tasks — one per blueprint.

```
task → resolve blueprint (index) → blueprint adapted within `adaptation` │ fresh compilation
     → runtime expression → generic Tiny executor → execution → evidence → disposal
```

What the runtime may rely on from this registry:

* the deterministic index (`index/registry-index.json`) for resolution by task class/intent/capabilities;
* immutable canonical versions addressed by `id@version` (+ seal digest);
* the adaptation contract (`mayAlter` / `mustPreserve` / `locked`) as the compiler's boundary;
* abstract capabilities and model policy, which the runtime maps to concrete tools/models it controls;
* effect classes, approval and compensation declarations for governing execution.

What the registry never provides: running agents, credentials, endpoints, concrete MCP commands or model IDs.
The runtime, not the registry, records execution evidence.
