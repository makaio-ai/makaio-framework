---
'@makaio/extension-filesystem': patch
---

Validate an opened file before starting the grep reader so asynchronous file checks cannot lose matching lines. Close the file handle on validation failure and release the reader on completion or early match-limit termination.
