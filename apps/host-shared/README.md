# @makaio/host-shared

Shared desktop host logic consumed by both `@makaio/electron` and `@makaio/electrobun`. It provides the common boot seams, renderer bootstrap, window-session persistence, and navigation handling that would otherwise be duplicated across the two composition roots.

## Architecture Role

`@makaio/host-shared` sits between the generic framework packages (kernel, runtime, contracts) and the host-specific composition roots. It is not a surface itself — it has no process entry point. Instead, it is a library of host-level abstractions that both desktop surfaces import to keep their composition roots thin and consistent.

```
@makaio/electron        @makaio/electrobun
        │                       │
        └──────────┬────────────┘
                   │
          @makaio/host-shared
          (boot seams, renderer, window session, navigation)
                   │
        @makaio/runtime-node  @makaio/kernel  @makaio/contracts
```

## Features

### Boot seams

- **`dev-host-options.ts`** — Resolves `MAKAIO_HOST_WORKSPACE_ROOT` from the environment and builds `NodeDevHostDescriptorDiscovery` for workspace-rooted extension discovery in dev mode. Both Electron and Electrobun call these helpers before passing options to `bootMakaioRuntime`.
- **`desktop-runtime-config.ts`** — Overlays a loaded `makaio.config.*` file onto the host-assembled boot options. The config owns extension discovery and package defaults; the host retains platform-specific metadata such as capabilities.
- **`startup-env.ts`** — Reads `MAKAIO_INITIAL_WINDOW` and `MAKAIO_INITIAL_<KEY>` env vars to resolve the first window registration ID and any context params at startup. Defines `FRAMEWORK_FALLBACK_WINDOW` (`framework-shell:main`).

### Window session persistence

- **`window-session.ts`** — Saves and loads the full set of open windows to the preferences service before shutdown and on startup. The storage key is host-scoped (`electron` vs `electrobun`) so the two hosts do not overwrite each other's sessions. Provides `WindowManagerState`, `PersistedWindowSession`, and the `saveWindowSession` / `loadWindowSession` helpers.

### Navigation

- **`navigation-handler.ts`** — Provides `registerHostNavigationHandler` and `resolveNavigation` so both desktop hosts handle `ui.navigate` bus events consistently. Also defines `assertNoReservedWindowParams` to guard against host-reserved query-param collisions.

### Renderer bootstrap

- **`src/renderer/`** — The shared React entry point (`App.tsx`, `bootstrap.tsx`) mounted by both Electron and Electrobun renderers. Connects to the bus, mounts `ExtensionBrowserLoader` for extension UI, and lazy-loads `TrayView` for the popover surface. Includes stubs for Node built-ins (`os`, `node:server`, `ssh2`, `cpu-features`) that cannot run in a browser renderer context.
- **`src/renderer/vite-assets.ts`** — Resolves renderer asset URLs at build time for both dev and production modes.

### Dev tooling

- **`dev-health-plugin.ts`** — Vite plugin that mounts a `/health` endpoint on the Vite dev server, used by Electrobun's health-probe singleton guard.

## Exports

`package.json` exposes named sub-path exports so consumers can import only what they need:

| Export path | Contents |
|-------------|---------|
| `.` (`src/index.ts`) | Core types and helpers: dev-host options, navigation handler, window session, startup env |
| `./desktop-runtime-config` | `applySelectedDesktopRuntimeConfig`, `applyDesktopRuntimeConfig` |
| `./bus` | Re-exports `HostNamespace` and `HostSubjects` from `@makaio/contracts` |
| `./renderer` | Shared `App`, `bootstrap`, and renderer utility re-exports |
| `./renderer/vite-assets` | Asset URL resolution for Vite builds |
| `./build/embedded-migrations` | Build-time helper for embedding DB migration files |
| `./build/workspace-paths` | Build-time workspace path resolution utilities |

## Key Files

| Path | Purpose |
|------|---------|
| `src/dev-host-options.ts` | Dev-host environment resolution and Node descriptor discovery |
| `src/desktop-runtime-config.ts` | Runtime config overlay for desktop boot options |
| `src/startup-env.ts` | `MAKAIO_INITIAL_WINDOW` parsing and `FRAMEWORK_FALLBACK_WINDOW` constant |
| `src/window-session.ts` | Window-session save/load against the preferences service |
| `src/navigation-handler.ts` | Shared `ui.navigate` bus handler and navigation resolution |
| `src/dev-health-plugin.ts` | Vite plugin for `/health` endpoint in dev mode |
| `src/renderer/App.tsx` | Shared React root — bus provider, extension loader, tray view |
| `src/renderer/bootstrap.tsx` | Renderer bootstrap — bus connection, React mount |
| `src/bus/namespace.ts` | Re-exports `HostNamespace` and `HostSubjects` side-effect registration |

## Installation

Private workspace package — not published to npm. Consumed internally by `@makaio/electron` and `@makaio/electrobun`.
