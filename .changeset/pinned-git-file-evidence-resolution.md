---
"@makaio/contracts": major
"@makaio/framework": major
---

Represent Git evidence repositories with the shared provider-qualified repository identity instead of a string. Add a typed evidence resolution RPC and a reusable Git-file resolver exposed through `@makaio/framework/evidence/git-file`. Resolution verifies the immutable source, rejects incomplete content and ranges, and preserves original line endings. Hosts supply authenticated source readers independently of Factory repository participation.
