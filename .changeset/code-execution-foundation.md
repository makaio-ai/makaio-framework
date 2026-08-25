---
"@makaio/bus-core": minor
"@makaio/contracts": minor
"@makaio/core": minor
"@makaio/framework": minor
"@makaio/runtime-node": minor
"@makaio/services-core": minor
---

Add the opt-in CodeExecution foundation: a `code-execution` contract namespace, a routing service, and a worker-thread provider for prepared TypeScript programs.

- New `@makaio/contracts` code-execution domain: the `code-execution` namespace with the `execute` RPC subject, `CodeExecutionRequest`/`CodeExecutionOutcome` schemas, the `ICodeExecutionProvider` contract, and the `registerCodeExecutionProvider`/`unregisterCodeExecutionProvider` capability helpers
- New `CodeExecutionService` and `codeExecutionPackage`, which select exactly one locally registered provider per invocation, own the invocation's effective budget, and normalize every path — missing provider, provider fault, timeout, cancellation — to one terminal outcome. The package is deliberately absent from the framework core package set: a host composes it only when it accepts executing submitted code
- `@makaio/framework` picks the whole surface up through its existing `./contracts`, `./services`, and `./runtime-node` subpaths, which re-export their source packages' root barrels: the namespace, schemas, registration helpers, `CodeExecutionService`, `codeExecutionPackage`, and `PiscinaCodeExecutionProvider` are all reachable from the umbrella package without a host adding a dependency on the individual packages
- The namespace-scoped bus wrappers now forward the dispatching option bags. `emit`, `request`, and `requestOptional` carry `EmitOptions` / `RequestOptions` on the shared scoped-bus surface in `@makaio/bus-core` (both option types are now exported from its root), the filtered bus passes them through instead of dropping them, and `MakaioBusLike.emit` in `@makaio/core` accepts the new `BusLikeEmitOptions` routing bag. This is what makes `registerCodeExecutionProvider`'s `transports: []` a checked local-only registration through every bus wrapper rather than only through the root bus
- New `PiscinaCodeExecutionProvider` in `@makaio/runtime-node`, which materializes each invocation's virtual module set into its own temporary program root, transpiles TypeScript on import inside a worker thread, and removes that root on every terminal path. It declares `trusted-code-only`: a worker thread bounds resource usage and makes an aborted execution terminable, but Node built-ins, absolute imports, dynamic loading, and filesystem access all remain available to executed code, so only submit code the host already trusts
