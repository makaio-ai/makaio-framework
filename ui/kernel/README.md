# @makaio/ui-kernel

Pure TypeScript contracts, registries, schemas, and utilities for framework UI packages.

## Package Surface

- Workspace package: `@makaio/ui-kernel`
- Assembled framework package subpath: `@makaio/framework/ui-kernel`
- Additional workspace subpaths: `@makaio/ui-kernel/pages/namespace` and
  `@makaio/ui-kernel/pages/schemas`

## Boundary

- No React runtime, DOM APIs, hooks, or JSX.
- React component shapes are type-only contracts through `ComponentLike`.
- Registries live here so hooks, views, and extension browser factories share the same
  framework-level contracts.

## Current Exports

- Widget infrastructure: `WidgetRegistry`, `widgetRegistry`, widget scopes, widget schemas,
  widget bus registration helpers, tray layout helpers, and widget layout types.
- Extension browser infrastructure: `ExtensionBrowserFactory`,
  `ExtensionBrowserContribution`, `registerExtensionBrowserFactory`,
  `resolveExtensionBrowserFactory`, `registerExtensionUI`, cleanup helpers, and shell style
  constants.
- Runtime readiness: `createRuntimeReadyWaiter` and related waiter types.
- Page infrastructure: page declarations, page definitions, page/section registries,
  layout persistence helpers, and page bus registration.
- Navigation: `NavigationRegistry`, navigation group config, UI namespace/schemas, and
  browser-target derivation.
- Onboarding: onboarding step contracts, registry, and plugin category helpers.

## Browser Contribution Contract

The framework browser loader expects `ExtensionInfo.browser.entrypoint` to import a callable
`ExtensionBrowserFactory`. The factory returns an `ExtensionBrowserContribution` containing
only `shell`, `pages`, `pageDefinitions`, `widgets`, and optional `destroy`. Host-specific
surfaces such as routes, tiles, tool formatters, field types, and config components are not
part of the framework loader contract unless a host-owned loader bridges them.
