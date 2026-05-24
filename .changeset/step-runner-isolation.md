---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add isolated workflow step runner contracts and Node runtime composition for agent and shell steps.

- `@makaio/contracts`: step runner configs now carry explicit bus auth, platform defaults, coordinator session IDs, cancellation subjects, and runner-only step typing; workflow roles can resolve provider context for agent execution.
- `@makaio/framework`: Node runtime boot can compose in-process, Piscina, child-process, and Docker workflow step runners with worker-local bus, tool, MCP, adapter, telemetry, and cancellation handling.
