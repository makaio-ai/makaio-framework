---
"@makaio/contracts": patch
"@makaio/extension-coderabbit": patch
"@makaio/framework": patch
---

Harden the workflow fluent API runtime and observable execution surface.

- Remove legacy workflow authoring remnants from the public contract surface.
- Persist primitive runtime frame and gate lifecycle updates consistently for WorkLog and dashboard consumers.
- Align workflow block, transition, and CodeRabbit-contributed workflow metadata with the fluent API contracts.
