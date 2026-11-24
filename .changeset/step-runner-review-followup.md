---
"@makaio/contracts": patch
"@makaio/framework": patch
"@makaio/runtime-node": patch
---

Decode Agent Step text against the declared output schema in both local and process execution. JSON-looking plain text can satisfy a string schema, and encoded JSON remains supported when it satisfies the schema.

Validate the Agent Step response before invoking a caller-local result finalizer, which can return its own output shape. Setting the optional `StepRunResult.outputFinalized` field to `true` attests that the runner validated the Agent Step response and applied the configured finalizer. By default, dispatch validates the returned output. Process-runner admission continues to reject steps configured with a result finalizer.

Preserve failure diagnostics in enclosing workflow frames while retaining machine-readable failure reasons. Reject non-JSON values returned by local Code Steps and refuse checkout launches when the step data belongs to a different workflow.

Verify tracked checkout paths literally, including leading or trailing whitespace.
