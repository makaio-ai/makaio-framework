---
"@makaio/framework": minor
"@makaio/runtime-node": minor
"@makaio/services-core": minor
---

Add an optional `fileAccessRuleProvider` boot option to `CoreBootOptions` (FACT-251), so a host can make the runtime enforce file-access rules (`.makaioignore` hierarchy plus built-in deny list), for example with `createMakaioIgnoreProvider()` from `@makaio/extension-filesystem`. Boot binds the provider into the framework tool registry, which injects the resolved rules into every tool execution context, and into the tool approval service, which denies file tool calls on restricted paths ahead of the policy cascade. Without the option, behaviour is unchanged.

`@makaio/services-core` adds `createFrameworkCorePackages({ fileAccessRuleProvider })` and the `FrameworkFileAccessOptions` type; without a provider it returns `frameworkCorePackages` itself. `selectFrameworkCorePackages` takes the same options as an optional second argument. Workflow-worker tool registries (Piscina workers and isolated workflow runtimes) do not receive the provider.
