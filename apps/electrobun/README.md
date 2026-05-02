# @makaio/electrobun

The Electrobun desktop surface for Makaio. This is the primary production desktop host — a hosted surface built on the Bun-native [Electrobun](https://electrobun.dev) runtime. It boots the full Makaio kernel and runtime in-process, serves the renderer SPA over a local HTTP/WebSocket port, and owns all desktop-chrome concerns: windows, system tray, session persistence, auto-launch, and signal-based shutdown lifecycle.

## Architecture Role

Surfaces sit at the top of the Kernel → Runtime → Platform → Surface layering. `@makaio/electrobun` is the Bun-native desktop composition root. It mirrors the Electron composition root structurally but diverges in platform-specific details:

- **Production** uses `Bun.serve()` with the Bun-native WebSocket transport (`BunBusServerTransportProvider`) and `hono/bun` for static serving.
- **Dev mode** uses `@makaio/runtime-node` with Vite owning the HTTP server (same single-port pattern as Electron).
- **Shutdown** is handled via `process.on('SIGTERM')` / `process.on('SIGINT')` rather than Electron's `before-quit` event.
- **Config injection** uses URL query parameters into window URLs; there is no preload script or `contextBridge`.

```
Electrobun main process (Bun)
  └─ HTTP/WS server (Bun.serve + BunBusServerTransportProvider | Vite dev)
       └─ bootMakaioRuntime (kernel, services, adapters, extensions)
            └─ bus WebSocket transport  ←→  renderer (Electrobun BrowserWindow)
```

## Features

- **Single-port architecture** — renderer SPA, bus WebSocket, and plugin HTTP routes share one port (`6252` by default).
- **Build variants** — `base` (system WebView) and `cef` (bundled Chromium Embedded Framework) variants, each on `stable` or `canary` release tracks, resolved at package time via `MAKAIO_VARIANT` and `MAKAIO_RELEASE_TRACK`.
- **Health-probe singleton guard** — in production, probes the default port at startup; focuses the existing instance and exits if one is already running.
- **Window management** — creates and tracks Electrobun `BrowserWindow` instances against the typed `WindowRegistry`; emits `host.window.opened` / `host.window.closed` bus events.
- **Session persistence** — saves and restores the full window set across restarts via the preferences service.
- **System tray** — native tray icon with a dynamically-built menu driven by `TrayMenuSubjects` bus events; includes an auto-launch toggle.
- **Tray popover** — lightweight floating SPA window toggled from the tray and via `Alt+Cmd/Ctrl+M` global shortcut.
- **Auto-launch** — macOS Login Item management exposed through the tray and bus.
- **In-app updates** — `upgrade-handler.ts` wires Electrobun's update mechanism to the bus.

## Development

```bash
# Build main process (Bun) + start Electrobun dev runner
yarn dev

# Watch mode — rebuilds main on change
yarn dev:watch

# Start Vite renderer only (no Electrobun process)
yarn dev:renderer

# Package all variants
yarn package:all-variants

# Package a specific variant/track
yarn package:base          # base variant, stable track
yarn package:cef           # CEF variant, stable track
yarn package:canary:base   # base variant, canary track
```

`MAKAIO_HOST_WORKSPACE_ROOT` points the dev runtime at a workspace root for extension descriptor discovery. See `@makaio/host-shared` for the full dev-host environment contract.

## Key Files

| Path | Purpose |
|------|---------|
| `src/main/main.ts` | Composition root — HTTP server, runtime boot, window/tray/shutdown wiring |
| `src/main/window-manager.ts` | Creates and tracks Electrobun `BrowserWindow` instances against the `WindowRegistry` |
| `src/main/bus-handlers.ts` | Desktop-chrome bus handler registration (window RPC, navigation, tray) |
| `src/main/tray.ts` | Native tray icon and dynamically-built menu with auto-launch toggle |
| `src/main/tray-popover.ts` | Lightweight floating SPA window toggled from tray and global shortcut |
| `src/main/auto-launch-controller.ts` | macOS Login Item management |
| `src/main/upgrade-handler.ts` | In-app update integration with Electrobun's update mechanism |
| `src/main/variant-detection.ts` | Reads build-time variant/renderer-backend metadata at runtime |
| `src/variant-config.ts` | Variant (`base`/`cef`) and release-track resolution, injected at build time |
| `src/health-probe.ts` | Probes the default port to detect an already-running instance |
| `src/second-instance.ts` | Connects to a running instance via the bus and sends `host.app.focus` |
| `src/renderer/main.tsx` | Renderer entry point — mounts the shared `App` from `@makaio/host-shared` |
| `electrobun.config.ts` | Electrobun platform configuration — window defaults, renderer backend, update channel |

## Installation

Private workspace package -- not published to npm. Installed from this source workspace.

---

*Part of the [Makaio AI Framework](../../README.md)*
