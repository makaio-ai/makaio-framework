# @makaio/ui-components

Presentational React components for the framework UI.

## Package Surface

- Workspace package: `@makaio/ui-components`
- Assembled framework package subpath: `@makaio/framework/ui-components`
- Stylesheet subpath: `@makaio/ui-components/style.css` when consuming the package directly

## Boundary

- Props in, callbacks out.
- Local React state and component-local hooks are allowed for presentation concerns such as
  disclosure, focus, menus, and measurement.
- No bus access, framework stores, service clients, or imports from `@makaio/ui-hooks` or
  `@makaio/ui-views`.
- Styles use `@makaio/ui-theme` tokens and SCSS modules.

## Current Exports

- Branding: `Logo`.
- Layout: `AppShell`, `ContentHeader`, `GlassPanel`, `IconSidebar`, `NavSidebar`, `SplitPane`,
  `Topbar`, `Page`, `ListPage`, and `SlotPanel`.
- Primitives: `Button`, `Badge`, `Panel`, `Input`, `Textarea`, `IconButton`, `Tooltip`,
  `Dropdown`, `Icon`, `FilterChipGroup`, `ButtonGroupFilter`, `Collapsible`, `ContextMenu`,
  `ModalPortal`, `Popover`, and `Toggle`.
- Themes: `ThemeProvider`, `useTheme`, theme tokens, and theme types.
- Icons: framework icon components and icon prop types.
- Utilities: `ConfirmDialog`, `PromptDialog`, `SlidePanel`, `ResizablePanel`, and
  `FatalErrorDialog`.
- Toast: `MultiActionToast`.
