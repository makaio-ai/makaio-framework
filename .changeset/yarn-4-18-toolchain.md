---
"@makaio/framework": patch
---

Pin the workspace package manager to Yarn 4.18.0. The framework keeps
`enableScripts: false` and does not opt into any Git repository allowlist, so
Yarn's default-deny policy for Git dependencies stays in force.
