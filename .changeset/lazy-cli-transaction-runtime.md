---
"@makaio/framework": patch
---

Keep extension install transaction imports independent of runtime boot dependencies.
Use the existing runtime configuration entrypoint for home resolution, and load
the framework version reader only when an npm installation requires it.
