---
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/subsystem-workflow-engine': minor
'@makaio/storage-pg': patch
---

Workflow definitions carry an `extensions` record keyed by extension name.

The workflow core stores the record unchanged and interprets none of it.
`defineWorkflow` accepts it as the option `extensions`. It rejects an invalid
extension name and a record that could not be stored unchanged (for example an
own `__proto__` key at any depth). Storage persists the record in a new column
of the workflow definitions table, and a save replaces the whole record: an
entry that is not sent is removed.
