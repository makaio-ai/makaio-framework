---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/subsystem-workflow-engine": major
"@makaio/runtime-node": major
"@makaio/storage-pg": patch
---

Workflows no longer wait inside a run. Gate nodes, paused results, suspension strategies, resume frames, and gate subjects are removed. A loop declares `check` instead of `gate`, and the check handler returns `pass` or `loop`. A loop defaults to `onExhausted: "fail"`. Set `onExhausted: "complete"` to continue after exhausting `maxRounds`. Every completed loop outputs `passed`, `rounds`, and `bodyOutputs`. The `passed` flag is true when a check passes and false when the loop completes at its limit. The former `outcome`, `lastGateOutcome`, and `resumeData` fields are gone. Update expressions that read them, including stored conditions on `frames.<id>.output.outcome`.

Every workflow node rejects unknown keys, including nested nodes. The workflow list reports rejected stored definitions with their IDs and validation reasons. The module loader also rejects older builder output containing `zodSchemas.gates`, even an empty object. Regenerate those modules with the current builder. The runtime validates worker inputs strictly. Consumers with their own provisioning-binding store must remove `suspensionStrategy` from stored inputs before reusing them. Workflow runs and run contexts no longer accept `dispatchMetadata`.

Frame persistence is required. A failing frame write fails the run after any started parallel branches or iterate items settle. For a previously stored frame, the runtime attempts to record the failure as a terminal frame transition. Span mirroring remains best-effort.

The migration rewrites supported legacy loop checks and sets `onExhausted: "complete"` on those loops to preserve their continuation behavior. It strips top-level layout from executable copies, fails runs that were waiting or whose executable copies contain incompatible legacy nodes, and clears external registration links to gate frames. The migration settles and detaches active Attempts belonging to those failed executions while preserving their historical outcomes and provider-operation records. A late result with an incompatible frozen instruction receives a permanent conflict. Historical gate records and the stored definition layout column remain. Gate frame and span records remain available to historical aggregation and are omitted from the narrow public frame, span, and worklog-entry readers. Historical paused worker observations are closed as `completed` because that status records the end of observation. The linked execution separately records its own result and any failure.

SQLite preserves duplicate keys in raw JSON and can rename more than one matching member. JavaScript parsing and PostgreSQL JSONB retain only the last duplicate member. PostgreSQL leaves opaque text instructions and outcomes with a decoded NUL or unsupported surrogate unchanged when JSONB cannot represent them. SQLite can structurally rewrite those documents without decoding their opaque values. PostgreSQL may also reorder object keys when it rewrites instruction text.
