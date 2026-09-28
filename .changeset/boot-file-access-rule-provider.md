---
"@makaio/framework": minor
"@makaio/runtime-node": minor
"@makaio/services-core": minor
"@makaio/tools-core": minor
---

Add an optional `fileAccessRuleProvider` boot option to `CoreBootOptions` (FACT-251), so a host can make the runtime enforce file-access rules (`.makaioignore` hierarchy plus built-in deny list), for example with `createMakaioIgnoreProvider()` from `@makaio/extension-filesystem`. Boot binds the provider into the framework tool registry, which injects the resolved rules into every tool execution context, and into the tool approval service, which denies file tool calls on restricted paths ahead of the policy cascade. Without the option, behaviour is unchanged.

The patterns apply inside the agent's working directory; paths outside it are governed by the agent's `allowedDirectories`. Only file tools with a path argument are inspected; shell commands and other tools without a path argument are not. With a provider configured, a known file-tool call from an agent without a working directory is denied (fail-closed), and boot fails when an extension overrides the framework tool registry or tool approval package, since the override would drop the provider.

`@makaio/services-core` adds `createFrameworkCorePackages({ fileAccessRuleProvider })` and the `FrameworkFileAccessOptions` type; without a provider it returns `frameworkCorePackages` itself. `selectFrameworkCorePackages` takes the same options as an optional second argument. Workflow-worker tool registries (Piscina workers and isolated workflow runtimes) do not receive the provider.

`@makaio/tools-core` recognises `Glob`, `Grep` (`path`) and `NotebookEdit` (`notebook_path`) as file tools, so the approval file-access check covers them; `Glob` and `Grep` without a path are not checked.
