---
"@makaio/contracts": major
"@makaio/runtime-node": major
"@makaio/framework": major
---

Make Worker provider requests workload-neutral: `WorkerProviderContext` and
`WorkerProvisionRequest` now carry selected non-secret Runtime inputs and a
private ephemeral connection instead of a workflow configuration and separately
resolved manifest. Providers must read bus URL, auth, and environment from the
new connection contract.

The built-in thin workflow provider now receives a typed workflow launch
resolver, so its workflow-specific configuration is reconstructed by the
workflow adapter rather than required by every Worker provider.
