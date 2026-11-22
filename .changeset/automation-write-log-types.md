---
'@makaio/contracts': minor
---

Add the write log contracts under `@makaio/contracts/journal`: write keys, write record and intent identifiers with their schemas, external object references (a `parent` chain longer than `EXTERNAL_OBJECT_REF_MAX_DEPTH` or containing a cycle fails validation) and create targets (identity fields must be non-empty), write requests and records, writer and write participant contributions (writer outcomes are mutually exclusive variants), and the writes capability. Types only.
