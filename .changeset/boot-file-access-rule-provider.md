---
"@makaio/framework": minor
"@makaio/runtime-node": minor
"@makaio/services-core": minor
"@makaio/tools-core": minor
---

Add an optional `fileAccessRuleProvider` boot option to `CoreBootOptions` (FACT-251), so a host can make the runtime enforce file-access rules (`.makaioignore` hierarchy plus built-in deny list), for example with `createMakaioIgnoreProvider()` from `@makaio/extension-filesystem`. Boot binds the provider into the framework tool registry, which injects the resolved rules into every tool execution context, and into the tool approval service, which denies file tool calls whose path argument names a restricted path (checked both as written and symlink-resolved) ahead of the policy cascade. Without the option, behaviour is unchanged.

The patterns apply inside the agent's working directory. With a provider configured, native file-tool calls outside the agent's `allowedDirectories` (else the profile's) are denied as well, ahead of any policy including a full-access override; without `allowedDirectories`, paths outside the working directory are not restricted by this check. Only file tools with a path argument are inspected; shell commands and other tools without a path argument are not. With a provider configured, a known file-tool call from an agent without a working directory is denied (fail-closed), and boot fails when an extension overrides the framework tool registry or tool approval package, since the override would drop the provider.

`@makaio/services-core` adds `createFrameworkCorePackages({ fileAccessRuleProvider })` and the `FrameworkFileAccessOptions` type; without a provider it returns `frameworkCorePackages` itself. `selectFrameworkCorePackages` takes the same options as an optional second argument. Workflow-worker tool registries (Piscina workers and isolated workflow runtimes) do not receive the provider.

`@makaio/tools-core` recognises `Glob`, `Grep` (`path`) and `NotebookEdit` (`notebook_path`) as file tools, so the approval file-access check covers them. `Glob` and `Grep` are checked on their supplied search root only: without a path they get no file-access check, and files they reach recursively are not filtered by `.makaioignore`. Filtering descendants needs OS-level isolation (Cyberport FACT-272).
