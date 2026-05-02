# @makaio/ui-hooks

React hooks, Zustand stores, providers, and bus-aware orchestration for framework UI.

## Package Surface

- Workspace package: `@makaio/ui-hooks`
- Assembled framework package subpath: `@makaio/framework/ui-hooks`

## Boundary

- May depend on `@makaio/ui-kernel`, framework contracts, runtime subjects, and the bus.
- Must not import from `@makaio/ui-components` or `@makaio/ui-views`.
- Owns React subscription and store lifecycle; views compose these hooks with components.
- This package is a framework-internal UI layer, not a guaranteed browser-extension runtime
  external.

## Current Exports

- Bus: `BusProvider`, `BusContext`, `useBus`, and `useOptionalBus`.
- Widgets: widget registry hooks, widget config hooks, widget layout hooks, tray layout, and
  focus-context layout helpers.
- Extension loading: `loadExtensionBrowserContributions` and loader result/options types.
- Stores: window context, page overlay, sidebar, focus, app context, provider store, and
  persisted-store helpers.
- Navigation and pages: navigation-level helpers, navigation handler registration, page
  definition/page component hooks, and grouped page helpers.
- Onboarding: core onboarding registration, skip/completion flags, onboarding flow hook,
  plugin persistence, and adapter/client scan helpers.
- Provider config: summary/detail selectors for UI views.
- Utilities: persisted agent selection parsing and related types.
