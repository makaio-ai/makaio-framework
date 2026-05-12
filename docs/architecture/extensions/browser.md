---
title: Browser & UI
description: Renderer architecture, shell inversion, and framework web primitives for browser extensions.
---

## Renderer architecture — host / shell inversion

The desktop renderer is a framework-layer host. It boots with `BusProvider` from
[`@makaio/ui-hooks`](../../../ui/hooks/README.md). `ExtensionBrowserLoader` then queries the bus for active extensions with
`ExtensionInfo.browser.entrypoint`, imports each browser entrypoint, and checks whether any
loaded `ExtensionBrowserFactory` returned a shell component:

- **Shell contribution installed:** Renders `<Shell bus={bus} />`, where `Shell` is
  the component exported via `ExtensionBrowserContribution.shell`. The shell owns
  any application-specific providers it needs, making the extension self-sufficient.
- **No shell contribution:** Renders the framework-owned `FrameworkShell` fallback.
- **Fatal loader/import failure before shell assembly:** Renders `EmptyStateUI` as an error
  surface.

The shell contribution is wrapped in a `ShellContribution` interface:
`{ component: ComponentType<ShellProps> }` where `ShellProps = { bus: IMakaioBus }`.
The shell renders the complete UI tree — it is not a wrapper around children passed
from the host.

```
BusProvider (framework)
  └── ExtensionBrowserLoader
        ├── Shell contribution installed → <Shell bus={bus}>
        │     └── Consumer-owned providers and UI
        ├── No shell contribution → <FrameworkShell bus={bus}>
        └── Fatal loader error → <EmptyStateUI />
```

This design gives the framework renderer zero consumer-layer imports. The shell
extension dynamically injects the application experience at runtime via
`ExtensionBrowserContribution.shell`. Host-owned loaders may bridge additional application UI
surfaces, but the framework loader's executable contract is the browser factory contribution
listed above.

## Browser extension invariant

The framework browser contribution invariant is:

1. `descriptor.json` declares `entrypoints.browser`
2. the platform bridge exposes a runtime `ExtensionInfo.browser.entrypoint` URL
3. the framework browser loader imports that URL
4. the module default resolves to a callable `ExtensionBrowserFactory`
5. the factory returns `shell`, `pages`, `pageDefinitions`, `widgets`, and optional `destroy`

The framework loader does not consume legacy application UI surfaces such as `routes`, `tiles`,
`toolFormatters`, `fieldTypes`, or `configComponent` from browser contributions. Likewise,
`MakaioExtension.ui` and descriptor `contributions.ui` are declarative metadata unless a
browser factory or host-owned loader bridges them into executable browser registrations.

## Framework web primitives

The former `@makaio/web-core` package has been split into focused packages that live under
`framework/ui/`. Framework-only renderer surfaces compose these
packages rather than importing from a single monolithic package.

**[`@makaio/ui-kernel`](../../../ui/kernel/README.md)** — pure contracts and registries (no React):

| Export | Kind | Purpose |
|--------|------|---------|
| `registerExtensionBrowserFactory` | Function | Extension registration API — called from browser entry bundles |
| `createRuntimeReadyWaiter` | Function | Waits for runtime boot signal before rendering extension UI |
| `ShellProps` | Type | `{ bus: IMakaioBus }` — props passed to every shell component |
| `ExtensionBrowserContribution` | Type | Contract returned by each extension's browser factory |
| `ExtensionBrowserFactory` | Type | Default-export shape of browser entry bundles |

**[`@makaio/ui-hooks`](../../../ui/hooks/README.md)** — React hooks, stores, providers, and bus-aware code:

| Export | Kind | Purpose |
|--------|------|---------|
| `BusProvider` | Component | Provides the `IMakaioBus` instance to a React tree |
| `useBus` | Hook | Reads the bus from `BusProvider` context |
| `useWindowContext` | Hook | Window navigation state (`windowId`, `activeProjectId`, `activeSessionId`, etc.) |

**[`@makaio/ui-views`](../../../ui/views/README.md)** — composed React views and shell components:

| Export | Kind | Purpose |
|--------|------|---------|
| `ExtensionBrowserLoader` | Component | Discovers and renders browser extensions; falls back to `FrameworkShell` when none supply a shell |
| `FrameworkShell` | Component | Framework-owned shell fallback for empty/no-shell renderer states |
| `EmptyStateUI` | Component | Minimal error surface rendered when browser extension loading fails before shell assembly |

## Import guidance

- Extension authors writing **browser entry bundles** may use type-only imports from framework
  packages because those imports are erased from the browser bundle.
- Runtime bare imports in extension browser entry bundles must be limited to the
  browser authoring externals: `react`, `react-dom`, `react/jsx-runtime`, and
  `@makaio/web-framework/extension-browser`.
- Do not runtime-import the root `@makaio/web-framework` barrel from extension browser
  entrypoints. Use `@makaio/web-framework/extension-browser` for browser contribution
  contracts and helpers, and use only documented browser-safe product subpaths for
  renderer-only UI hooks. The root barrel may still appear in the host shared externals
  list for legacy host-owned chunks, but it is not an extension browser authoring surface.
- Do not runtime-import framework internals such as [`@makaio/ui-hooks`](../../../ui/hooks/README.md) from browser entry
  bundles. The host import map only guarantees the shared externals above.
- Extension authors writing shell UI should keep application-specific providers inside
  the shell contribution instead of adding them to framework UI packages.

## Browser authoring contract

Browser-capable extensions build against a framework-owned shared externals
contract. The current canonical shared browser specifiers are defined in
[`@makaio/build-tooling/browser-shared-externals`](../../../build-tooling/browser-shared-externals.ts) and are used by both:

- [`@makaio/build-tooling/tsdown-extension-preset`](../../../build-tooling/tsdown-extension-preset.ts)
- host import-map generation
- author-time verification

Extension authors do not maintain import-map data by hand.

<!-- web:hide -->

## Key source files

| File | Purpose |
|------|---------|
| `../ui/kernel/src/extensions/types.ts` | `ShellProps`, `ShellContribution`, `ExtensionBrowserContribution` |
| `../ui/views/src/extensions/ExtensionBrowserLoader.tsx` | `ExtensionBrowserLoader` |
| `../ui/kernel/src/index.ts` | Contracts, registries, and extension types |
| `../ui/hooks/src/index.ts` | `BusProvider`, `useBus`, `useWindowContext` |
| `../ui/views/src/index.ts` | `ExtensionBrowserLoader`, `EmptyStateUI` |
| `../scripts/lib/generate-import-map.ts` | Import-map generation |
| `../build-tooling/tsdown-extension-preset.ts` | Extension build preset |

<!-- /web:hide -->
