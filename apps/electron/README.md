# @makaio/electron

The Electron desktop surface for Makaio. This is a hosted surface — it boots the full Makaio kernel and runtime in-process (no external daemon), serves the renderer SPA over a local HTTP/WebSocket port, and owns all desktop-chrome concerns: windows, system tray, notifications, session persistence, and shutdown lifecycle.

## Architecture Role

Surfaces sit at the top of the Kernel → Runtime → Platform → Surface layering. `@makaio/electron` is the Node-based desktop composition root. It delegates all service, adapter, and extension wiring to `@makaio/runtime-node` via `bootMakaioRuntime`, then layers Electron-specific concerns — `BrowserWindow` management, tray menu, `electron-builder` packaging — on top of the running runtime.

The bus server runs in-process on a single TCP port (`6252` by default). In dev mode Vite owns that port and HMR shares it with the bus WebSocket transport; in production `@hono/node-server` serves the built renderer and plugin HTTP routes on the same port.

```
Electron main process
  └─ HTTP/WS server (Hono + node-server | Vite dev)
       └─ bootMakaioRuntime (kernel, services, adapters, extensions)
            └─ bus WebSocket transport  ←→  renderer (BrowserWindow)
```

## Features

- **Single-port architecture** — renderer SPA, bus WebSocket, and plugin HTTP routes share one port.
- **Window management** — creates, focuses, and restores windows from a typed `WindowRegistry`; emits `host.window.opened` / `host.window.closed` bus events.
- **Session persistence** — saves and restores the full window set across restarts via the preferences service.
- **System tray** — native tray icon with a dynamically-built menu driven by `TrayMenuSubjects` bus events.
- **Tray popover** — lightweight floating SPA window toggled from the tray.
- **Notifications** — `ElectronNotificationProvider` implements the framework notification contract.
- **Single-instance lock** — enforced in production; `app.second-instance` focuses the running window or opens the default window.
- **Boot error window** — displays a native error view if runtime boot fails, rather than silently exiting.
- **macOS packaging** — `electron-builder.yml` produces a signed, notarization-ready `arm64` DMG with native modules unpacked from the asar archive.

## Development

```bash
# Start Electron with Vite dev server (single-port, HMR enabled)
yarn dev

# Start Vite renderer only (no Electron main process, bus server in Vite plugin)
yarn dev:renderer

# Build main process (esbuild) + renderer (Vite) separately, then package
yarn build:all
yarn package
```

`MAKAIO_HOST_WORKSPACE_ROOT` points the dev runtime at a workspace root for extension descriptor discovery. See `@makaio/host-shared` for the full dev-host environment contract.

## Key Files

| Path | Purpose |
|------|---------|
| `src/main/main.ts` | Composition root — HTTP server, runtime boot, window/tray/shutdown wiring |
| `src/main/window-manager.ts` | Creates and tracks `BrowserWindow` instances against the `WindowRegistry` |
| `src/main/bus-handlers.ts` | Desktop-chrome bus handler registration (window RPC, navigation, notifications) |
| `src/main/tray.ts` | Native tray icon and dynamically-built menu |
| `src/main/tray-popover.ts` | Lightweight floating SPA window toggled from the tray |
| `src/main/boot-error.ts` | Native error window shown on boot failure |
| `src/renderer/main.tsx` | Renderer entry point — mounts the shared `App` from `@makaio/host-shared` |
| `electron-builder.yml` | Packaging configuration — asar layout, native-module unpacking, macOS code signing |

## Installation

Private workspace package -- not published to npm. Installed from this source workspace.
