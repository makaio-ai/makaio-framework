---
"@makaio/contracts": major
"@makaio/runtime-node": major
"@makaio/framework": major
"@makaio/cyberport-factory": major
---

Make Worker provider requests workload-neutral: `WorkerProviderContext` and
`WorkerProvisionRequest` now carry selected non-secret Runtime inputs and a
private ephemeral connection instead of a workflow configuration and separately
resolved manifest. Providers must read bus URL, auth, and environment from the
new connection contract.

The built-in thin workflow provider now receives a typed workflow launch
resolver, so its workflow-specific configuration is reconstructed by the
workflow adapter rather than required by every Worker provider.

Expose the generic Worker-start composition and its explicit workflow adapter
through the `@makaio/cyberport-factory/factory-execution` facade.

Breaking facade changes:

- `verifyAttemptProvisioningBinding` now accepts `(binding, signal,
  readInstruction, resolveCanonicalSelection?)` instead of the former
  bus-first argument order.
- `rebuildAttemptProvisionRequest` requires a workload-owned canonical
  selection resolver when the frozen binding references a canonical dispatch.

This changeset publishes the framework and facade contracts together. Consumer
adoption is a separate gate: downstream hosts must update to the published
versions and provide the explicit workflow resolver where their bindings use
canonical dispatch selection.
