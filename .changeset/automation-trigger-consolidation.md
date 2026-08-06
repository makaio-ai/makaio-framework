---
'@makaio/contracts': major
'@makaio/framework': major
'@makaio/services-core': major
'@makaio/subsystem-workflow-engine': major
---

Replace workflow-specific trigger catalogs and evaluators with extension-contributed Automation Trigger Types and shared bindings. Rename extension hash-trigger contributions to `hashTriggers`, migrate workflow bindings to `{ kind, params }`, and remove inert manual, webhook, and opaque extension trigger variants.
