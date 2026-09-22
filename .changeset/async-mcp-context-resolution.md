---
'@makaio/framework': minor
---

Allow MCP context resolvers to resolve asynchronously before tool execution.
Both stdio and HTTP requests await the resolver; a rejected resolution prevents
execution, while existing synchronous resolvers and undefined fallbacks retain
their behavior.
