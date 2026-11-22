---
'@makaio/contracts': minor
'@makaio/core': minor
---

Add the journal contracts under `@makaio/contracts/journal`: journal entries and their origin, record and accept inputs, reader contributions and reader outcomes, edge cursors, the journal capability and `JournalError`, the identifier schemas `EntryIdSchema`, `SubjectNameSchema`, `SubjectPatternSchema` and `PositionSchema` (subject names and patterns follow the bus grammar, checked by the new `isSubjectName` and `isSubjectPattern` in `@makaio/core`), and the bus namespaces `makaio:journal` (entries, reader states, reprocess, writes, resolve-write) and `makaio:subjects` (subject directory), registered with `makaio:rights` and `makaio:access` in `FrameworkContractNamespaces`. `@makaio/core` now owns `JsonValue` and `JsonValueSchema` (re-exported by `@makaio/contracts` unchanged) and adds the bus delivery metadata `BusDeliveryMetadata`. `JsonObject` is available from `@makaio/contracts/shared`. Types only: nothing records or reads entries yet.
