---
"@makaio/contracts": minor
"@makaio/extension-artifact-patch": minor
"@makaio/runtime-node": minor
---

Enforce addressable-part id invariants at write time and expose part resolution to workflows.

`@makaio/contracts` adds the `PAYLOAD_INVARIANT_FAILED` patch error code for payload
invariants JSON Schema cannot express (blank title, missing/blank/duplicate part ids);
these previously misreported as `SCHEMA_VALIDATION_FAILED`. Conjunct combination now
preserves `prefixItems`, so tuple schemas composed via `allOf`/`anyOf`/`$ref` with
siblings are rejected as addressable part areas like their inline equivalents.

`@makaio/extension-artifact-patch` validates part ids on every patch result (including
dry runs and schema-version migrations, which enforce the target registration's areas)
and reports violations as `PAYLOAD_INVARIANT_FAILED`.

`@makaio/runtime-node` grants workflow execution attempts access to the
`artifact.resolvePart` subject.
