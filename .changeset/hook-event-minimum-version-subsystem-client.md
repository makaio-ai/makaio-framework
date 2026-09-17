---
"@makaio/subsystem-client": minor
---

Pass `minimumVersion` through in session-event descriptors and export `isSessionEventSupported`.

`SessionEventDescriptor` gains an optional `minimumVersion?: string` field.
`deriveSessionEventDescriptors` carries the value through from the client
definition when declared (key absent otherwise, preserving existing deep-equality
behaviour). New `isSessionEventSupported` predicate: returns `true` when no
minimum is declared, when the binary version is unknown (`null`/`undefined`), or
when the binary version satisfies `>= minimumVersion`.
