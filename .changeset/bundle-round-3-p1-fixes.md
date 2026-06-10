---
"@makaio/subsystem-workflow-engine": patch
"@makaio/extension-subagent": patch
"@makaio/expression": patch
"@makaio/adapter-anthropic-sdk": patch
"@makaio/framework": patch
---

Fix three consumer-blocking defects found against the published bundle.

Subagent await RPCs (workflow-engine delegate nodes and the parent await tool) now opt out of the 60s bus envelope timeout via `{ timeout: 0 }`; the deadline is owned by the await handler (`node.timeoutMs`, falling back to the `defaultAwaitTimeoutMs` constraint of 300s), so delegate turns longer than a minute no longer die mid-flight.

`resolveTemplate` now evaluates through the shared expression engine instance instead of the `jexl-extended` default import, which under native Node ESM resolves to the CJS namespace object and silently turned every `{{ }}` interpolation into an empty string; evaluation errors are now logged instead of swallowed.

`@makaio/adapter-anthropic-sdk` ships a loadable server entry (`dist/server.mjs` plus the `./server` export), so extension discovery can load the adapter without manual `createAnthropicSdkAdapter` registration.
