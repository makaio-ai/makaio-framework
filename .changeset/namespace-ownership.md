---
"@makaio/framework": major
"@makaio/contracts": major
"@makaio/runtime-node": minor
"@makaio/adapter-anthropic-sdk": patch
"@makaio/adapter-claude-agent-sdk": patch
"@makaio/adapter-claude-code-cli": patch
"@makaio/adapter-claude-code-tmux": patch
"@makaio/adapter-codex-app-server": patch
"@makaio/adapter-cursor-sdk": patch
"@makaio/adapter-openai-node": patch
"@makaio/adapter-pi-sdk": patch
"@makaio/adapter-qwen-acp": patch
---

Every bus namespace registration names its holder: an extension or the host.
An extension claims a namespace through its manifest or through
`ctx.namespaces.lease(definition)`; `bus.registerNamespace(s)` registers as the
host. A claim by a second holder fails with `namespace-already-owned`, naming
both holders. The core prefixes (`makaio:` and channels) belong to the host.
A failed start, a failed re-enable and shutdown release an extension's
namespaces; a released namespace has no holder and is unregistered. The kernel
API answers `ownerOf`, `listOwners`, `hasNamespace` and `namespaceOf`.

Namespaces created at runtime are claimed for their extension: adapter
connector namespaces (leased by the adapter contribution processor before the
factory runs), detached extension lifecycle namespaces, workflow success
finalizers and the execution target.

Breaking changes:

- `IMakaioBus` no longer offers `registerNamespace`/`registerNamespaces`; the
  new `IHostMakaioBus` adds them and is what host factories return. An
  extension's `ctx.bus`, a contribution context's bus and an adapter's
  `globalBus` are `IMakaioBus`. Extension authors declare namespaces in the
  manifest or claim them with `ctx.namespaces.lease(definition)`; an untyped
  registration on an extension's bus is routed to that extension's lease.
- An extension that also registered its own manifest domain on the host bus
  keeps working: the registration now goes through its lease and is
  idempotent.
- `ExtensionContext` requires `namespaces`.
- A second extension declaring a namespace another extension holds fails
  activation with `namespace-already-owned` instead of a warning.
- The adapter definition contract requires `busNamespace`; adapters no longer
  register their namespace themselves, and scoping an adapter namespace no
  longer registers it.
- `WorkflowExecutor` and `WorkflowEngineService` require the namespace
  capability as a constructor argument; `ExecutionTargetService` takes it as its
  second argument.
- One exported `AdapterDefinitionInvalidError` (from the adapter subsystem)
  rejects an adapter definition without `busNamespace` (code
  `bus-namespace-missing`) and an instance that uses another namespace than its
  definition names (code `bus-namespace-mismatch`); initializing several
  adapters reports the original errors as an `AggregateError`.
- Disabling an extension releases its namespaces; only a service that is
  retained after a failed destroy keeps them until shutdown. Such a service is
  kept until shutdown, and re-enabling the extension is rejected until the
  process restarts. A released namespace keeps its local routing marks without
  a holder until it is claimed again, so remote messages on its local subjects
  are still dropped. A lease requested
  through a closed capability fails with `namespace-capability-closed`; a claim
  in the workflow worker's toolset context fails with
  `worker-namespace-claim-unavailable`. The codes are exported as
  `NAMESPACE_ALREADY_OWNED`, `NAMESPACE_CAPABILITY_CLOSED` and
  `WORKER_NAMESPACE_CLAIM_UNAVAILABLE` from the extension contracts;
  `NamespaceCapabilityClosedError` is exported from the kernel.
- `createStorageNamespace` is removed from `@makaio/storage-core` and
  `@makaio/storage-drizzle`; build storage namespaces with
  `createStorageNamespaceDefinition` and declare or lease them like any other
  namespace.
- `FrameworkContractNamespaces` no longer lists `WorkflowNamespace` and
  `GitHookNamespace`; the services-core catalog no longer lists `cliDetection`
  and `execution-target`.
