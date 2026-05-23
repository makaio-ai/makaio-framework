---
"@makaio/extension-account-manager": patch
"@makaio/extension-claude-code-statusline": patch
"@makaio/extension-client-commands": patch
"@makaio/extension-client-hooks": patch
"@makaio/extension-coderabbit": patch
"@makaio/extension-filesystem": patch
"@makaio/extension-opencode": patch
"@makaio/extension-pin-message": patch
"@makaio/extension-prompt": patch
"@makaio/extension-review": patch
"@makaio/extension-shell": patch
"@makaio/extension-subagent": patch
---

**@makaio/extension-account-manager**
- Migrates account-manager build configuration from adapter to extension preset and updates external module configuration from explicit names (`'ink'`, `'react'`) to regex patterns matching `ink` and `react` subpaths.

**@makaio/extension-claude-code-statusline**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-client-commands**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-client-hooks**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-coderabbit**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-filesystem**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-opencode**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-pin-message**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-prompt**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-review**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-shell**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.

**@makaio/extension-subagent**
- Updates build configuration in remaining nine extensions from adapter preset (`defineAdapterConfig`) to extension preset (`defineExtensionConfig`), removing explicit `dts: false` settings. All scripts continue to call `emitDeclarations()` for TypeScript declaration output after the build.
