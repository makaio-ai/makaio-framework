# @makaio/build-tooling

Shared Vite factories and tsdown presets for Makaio framework packages, adapters, and extensions.

## Overview

This package provides:

- Vite factories for dual-target package and adapter builds
- TypeScript declaration generation for Vite-built packages
- React/SCSS support for Vite package builds
- tsdown presets for framework distribution and standalone extension bundles
- Shared browser external declarations for extension import maps

Vite factories bundle `@makaio/*` workspace packages through tsconfig path resolution. The tsdown
presets separately preserve the bus singleton by keeping `@makaio/bus-core` external or rewriting it
to the framework bus entrypoint, depending on the distribution target.

## Quick Start

### For Extension Scaffolds

```typescript
// extensions/my-extension/tsdown.config.ts
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export default defineExtensionConfig({
  entry: ['./src/index.ts'],
});
```

Extension scaffolds should use `defineExtensionConfig()` and the tsdown extension preset. Do not use
`createPluginConfig()` for new standalone Makaio extension bundles; that Vite helper is for
React/SCSS package builds.

### For Vite Packages (React/SCSS)

```typescript
// framework/packages/my-ui-package/vite.config.ts
import { createPluginConfig } from '@makaio/build-tooling/plugin';

export default createPluginConfig({
  packageRoot: import.meta.dirname,
});
```

### For Adapters (headless)

```typescript
// adapters/my-adapter/vite.config.ts
import { createAdapterConfig } from '@makaio/build-tooling/adapter';

export default createAdapterConfig({
  packageRoot: import.meta.dirname,
  external: ['some-sdk'],
});
```

## Exports

| Export | Description |
|--------|-------------|
| `@makaio/build-tooling/base` | Base utilities and shared configuration |
| `@makaio/build-tooling/plugin` | Vite package build configuration (React, SCSS) |
| `@makaio/build-tooling/adapter` | Adapter build configuration (headless) |
| `@makaio/build-tooling/browser-shared-externals` | Shared browser external contract for host import maps |
| `@makaio/build-tooling/rolldown-plugin-framework-externals` | `frameworkExternals()` Rolldown plugin export |
| `@makaio/build-tooling/tsdown-framework-preset` | Framework tsdown presets and bus singleton rewrite plugin |
| `@makaio/build-tooling/tsdown-extension-preset` | Standalone extension tsdown preset and `defineExtensionConfig()` |

## API Reference

### `defineExtensionConfig(options)`

Creates a tsdown config for standalone extension bundles. It bundles workspace packages except
`@makaio/bus-core`, externalizes shared browser dependencies, and leaves package manifests as
authored metadata.

```typescript
interface ExtensionPresetOptions {
  entry?: string | string[] | Record<string, string>; // Default: ['./src/index.ts']
  nativeModules?: string[];                           // Native addons to externalize
  external?: ReadonlyArray<string | RegExp>;          // Extra heavy/host-resolved deps
}
```

### `createPluginConfig(options)`

Creates a dual-target Vite configuration array for React/SCSS package builds.

```typescript
interface PluginConfigOptions {
  packageRoot: string;           // Absolute path to package root
  entry?: string;                // Entry point (default: 'src/index.ts')
  external?: (string | RegExp)[]; // Additional externals
  react?: boolean;               // Include React JSX transform (default: true)
  plugins?: PluginOption[];      // Additional Vite extensions
  css?: {
    extract?: boolean;           // Extract CSS (default: true for browser)
    modules?: {
      generateScopedName?: string;
    };
  };
  overrides?: UserConfig;        // Override/extend base config
}
```

### `createAdapterConfig(options)`

Creates a dual-target Vite configuration array for adapter packages.

```typescript
interface AdapterConfigOptions {
  packageRoot: string;           // Absolute path to package root
  entry?: string;                // Entry point (default: 'src/index.ts')
  external?: (string | RegExp)[]; // Additional externals
  plugins?: PluginOption[];      // Additional Vite extensions
  needsCreateRequire?: boolean;  // Add createRequire banner for CJS deps
  banner?: string;               // Custom banner code
  overrides?: UserConfig;        // Override/extend base config
}
```

### Programmatic Build

```typescript
import { buildPlugin } from '@makaio/build-tooling/plugin';
import { buildAdapter } from '@makaio/build-tooling/adapter';

// Build a Vite React/SCSS package
await buildPlugin({ packageRoot: import.meta.dirname });

// Build an adapter
await buildAdapter({ packageRoot: import.meta.dirname });
```

## Build Output

The Vite package and adapter configs produce:

```
dist/
├── browser/
│   ├── index.js      # ESM bundle
│   ├── index.js.map  # Source map
│   ├── index.d.ts    # TypeScript declarations
│   └── index.css     # (plugins only) Extracted CSS
└── node/
    ├── index.js      # ESM bundle (Node target)
    ├── index.js.map
    └── index.d.ts
```

## Default Externals

The Vite factories externalize these third-party packages by default:

- `react`, `react-dom`, `react-router`
- `zod`

Workspace packages (`@makaio/*`) are bundled by Vite, not externalized.

For tsdown framework builds, `frameworkPreset` bundles workspace packages except `@makaio/bus-core`,
which `frameworkExternals()` rewrites to `@makaio/framework/bus` in JS and declaration output. For
tsdown extension builds, `defineExtensionConfig()` bundles workspace packages except `@makaio/bus-core`
and externalizes `SHARED_BROWSER_EXTERNALS` so host shells can provide shared browser singletons.

## File Structure

```
build-tooling/
├── browser-shared-externals.ts # Shared browser dependency contract
├── tsdown-extension-preset.ts  # Standalone extension preset
├── tsdown-framework-preset.ts  # Framework distribution presets
├── vite.base.ts                # Shared Vite utilities and base config
├── vite.plugin.ts              # Vite React/SCSS package configuration factory
├── vite.adapter.ts             # Vite adapter configuration factory
├── package.json
└── README.md
```

---

*Part of Makaio Framework*
