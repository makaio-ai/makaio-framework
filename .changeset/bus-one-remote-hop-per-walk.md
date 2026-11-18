---
"@makaio/bus-core": patch
---

Request dispatch sends each transport at most one remote hop per walk. A peer that advertises several priorities for a subject used to receive one hop per advertised entry, and because every hop runs the peer's whole chain below its cursor, the peer's lower-priority middleware ran once per entry. Its later entries in the same walk are now covered: never sent, whether the first hop returned `NoHandlerError` or failed. A covered entry still bounds the cursor of the next remote hop, so a later transport starts below the priority the walk already passed instead of above it. A nested walk entered with a lower cursor counts its hops afresh.

A node entered with a priority cursor no longer forwards a larger cursor to the next transport. When the first entry it walks was remote, the cursor came from the entry before it, which the incoming cursor had skipped, so the next peer could run a handler above the range the originating walk had already passed.
