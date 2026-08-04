---
'@makaio/subsystem-workflow-engine': patch
---

Serialize the SQLite execution-attempt test adapter by database identity so independent handles cannot leave a shared
fixture locked after contended transaction control.
