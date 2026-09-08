---
"@makaio/contracts": patch
"@makaio/framework": patch
---

Validate complete Artifact Kind schemas before registry changes, preserving existing registrations when an owner batch is invalid. Honor the Artifact data root object guarantee when validating declared title and data paths, without assuming nested values are objects.
