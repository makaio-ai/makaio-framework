---
'@makaio/subsystem-workflow-engine': patch
---

Fix a trigger condition pre-run check that treated a name-table entry (`properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas`, or draft-07 `dependencies`) named like a data keyword (`const`, `enum`, `default`, `examples`) as instance data, leaving a local reference inside it unrebased and the subtree open to unknown paths and mismatched operand types. An already-persisted workflow whose trigger event schema has such an entry may now be rejected the next time its binding is reconciled (`compileWorkflowTriggerCondition` in `workflow-trigger-preflight.ts`) or re-awaited, not only at save time.
