---
"@makaio/framework": patch
---

Align `drizzle-orm` on 0.45.4 at every pin so a single version resolves.
`@libsql/client` stays on 0.17.x: 0.18 introduces a connection pool that rolls
back a raw `BEGIN` when the connection is released, which the raw-session
pattern used by migrations does not survive.
