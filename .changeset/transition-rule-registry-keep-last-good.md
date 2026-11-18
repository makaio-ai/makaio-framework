---
"@makaio/framework": minor
"@makaio/services-core": minor
---

`TransitionRuleRegistry` gains `replace(sourceKey, rules)`, which atomically replaces all rules of a source and keeps the source's previous rules registered when the replacement is rejected (invalid rule definition or condition, a rule ID duplicated within the batch, or a rule ID owned by another source). A replacement may reuse the source's own current rule IDs; an empty replacement deregisters the source. `validateReplacement(sourceKey, rules)` runs the same checks without changing the registry, so a source whose rules depend on state it publishes elsewhere (for example the workflow definitions its rules start) can reject a whole update before publishing that state, then call `replace` afterwards. `register` still rejects an already registered source.
