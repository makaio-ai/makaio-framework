# @makaio/ui-views

Composed React views, shell surfaces, and smart UI components for framework renderers.

## Package Surface

- Workspace package: `@makaio/ui-views`
- Assembled framework package subpath: `@makaio/framework/ui-views`
- Stylesheet subpath: `@makaio/ui-views/style.css` when consuming the package directly

## Boundary

- May compose `@makaio/ui-kernel`, `@makaio/ui-theme`, `@makaio/ui-components`, and
  `@makaio/ui-hooks`.
- Owns framework view composition, shell fallback behavior, widget canvas rendering,
  extension browser loading, and navigation views.
- Host/application domain UI should live in host packages or extensions and enter the
  framework through explicit browser factory contributions.

## Current Exports

- Widget rendering: `WidgetContainer`, `WidgetCanvas`, `WidgetGrid`, `WidgetPalette`,
  `WidgetErrorBoundary`, drag payload helpers, and `frameworkStatusWidgetDefinition`.
- Shell: `FrameworkShell`, `BusStatusIndicator`, and `TrayView`.
- Extension loading: `ExtensionBrowserLoader` and `EmptyStateUI`.
- Page rendering: `PageErrorBoundary`.
- Navigation: `Sidebar`.
- Toast: `ToastProvider`.

## Loader Behavior

`ExtensionBrowserLoader` imports active `ExtensionInfo.browser.entrypoint` URLs. Entrypoints must
resolve under `/extensions/` and import a callable `ExtensionBrowserFactory`. If loaded
contributions supply `shell`, the last loaded shell wins and renders the root workspace. If no shell
is supplied, the framework renderer falls back to `FrameworkShell`. `EmptyStateUI` is reserved for
loader/import errors before shell assembly; host-owned loaders may differ when they bridge
application-specific surfaces.
