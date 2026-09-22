---
'@makaio/contracts': minor
'@makaio/framework': minor
'@makaio/storage-pg': minor
---

Add atomic, principal-owned imported-session registration and owner verification.

`storage:session.registerOwnedImport` creates a session with its owner in one
operation, or reports the requesting principal's relationship to an existing
row without modifying it. `storage:session.verifyOwner` reports the same
relationship for a known session. Neither response exposes a stored principal
identity.
