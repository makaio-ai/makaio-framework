---
title: Desktop Apps
description: Build desktop applications with Makaio using Electron and Electrobun host shells.
---

Makaio ships three host applications — two desktop GUI hosts and one headless CLI host. The two
desktop hosts share platform-neutral shell code via `@makaio/host-shared`; the CLI uses the same
runtime boot path headlessly. This document explains why the project maintains two parallel desktop
hosts, how they relate, and how to keep them in sync.

---

## Why Two Desktop Hosts

### Electron — The Shipping Host

Electron is the primary distribution target. It is mature, battle-tested across thousands of
production desktop apps, and backed by a deep ecosystem (electron-builder, auto-updater,
code-signing tooling, Chromium DevTools, native module support). The trade-off: Electron
bundles a full Chromium renderer and Node.js runtime, resulting in large binary sizes (~200 MB)
and higher baseline memory consumption.

**Strengths:**
- Proven at scale (VS Code, Slack, Discord, Notion)
- Rich native integration APIs (`screen`, `globalShortcut`, `Notification`, `contextBridge`)
- Mature packaging and update story (`electron-builder`, Squirrel, NSIS, DMG)
- Synchronous window state queries (`win.isVisible()`, `win.getBounds()`)
- Strong community and external tooling

**Weaknesses:**
- Large binary footprint (Chromium + Node.js)
- High baseline memory usage per window
- Slow cold-start on some machines
- Node.js event loop — no native multithreading without worker_threads

### Electrobun — The Forward Bet

Electrobun is a Bun-native desktop framework that uses the system's installed web view (CEF on
Linux, WebKit on macOS) instead of bundling Chromium. It promises significantly smaller binaries,
lower memory usage, and the performance benefits of Bun's runtime (native FFI, fast startup,
built-in bundler). The trade-off: Electrobun is young, its API surface is still evolving, and
some platform integrations are not yet at parity with Electron.

**Strengths:**
- Dramatically smaller binary (no bundled Chromium)
- Lower memory footprint
- Bun-native: fast startup, native WebSocket, built-in bundler
- Modern architecture without legacy Chromium baggage

**Weaknesses:**
- Young project — API surface still evolving
- Missing some platform APIs that Electron currently exposes
- No equivalent to `contextBridge`/preload — config injection via URL query params
- Notification API not yet implemented
- Smaller community and fewer packaging/signing tools

### The Strategy

Electron ships today. Electrobun is a parallel investment so we are ready to switch (or offer
both) when Electrobun reaches production maturity. By maintaining both hosts against the same
`host-shared` library, we:

1. **Keep Electrobun honest** — real integration, not a theoretical port
2. **Validate the abstraction** — host-shared only earns code that works across both
3. **Reduce future migration cost** — when Electrobun is ready, the delta is small
4. **Provide user choice** — power users can opt into the lighter host early

---

## Architecture

Both desktop hosts are thin platform shells. Each one embeds a Hono HTTP server, a bus with
WebSocket transport, and a `bootMakaioRuntime()` service graph in its main process. Electron
uses `@makaio/runtime-node` for all modes; Electrobun uses `@makaio/runtime-node` in dev
(Vite runs on Node) and `@makaio/runtime-bun` in production (Bun-native HTTP + WebSocket). On the renderer side, both load the identical React application — the shared
`bootstrapRenderer` connects a WebSocket bus client, waits for service boot, and mounts the
same `<App />` tree. The only code that differs is the platform glue: how the HTTP server is
created, how the WebSocket upgrade is handled, and how config reaches the renderer.

```
┌─────────────────────────────────────────────────────────────────┐
│  Main process (Electron or Electrobun)                          │
│                                                                 │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ Hono HTTP   │  │ Bus + WebSocket  │  │ bootMakaioRuntime │  │
│  │ server      │──│ transport        │──│ (services, exts)  │  │
│  └─────────────┘  └──────────────────┘  └───────────────────┘  │
│         ↕ platform-specific glue only                           │
└─────────────────────────────────────────────────────────────────┘
          │  ws://127.0.0.1:<port>/bus
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Renderer (shared React app)                                    │
│  bootstrapRenderer → WebSocket bus client → <App />             │
│  Same code, same bundle — loaded identically by both hosts      │
└─────────────────────────────────────────────────────────────────┘
```

```
apps/
├── host-shared/     @makaio/host-shared    Shared desktop host library
├── electron/        @makaio/electron        Electron desktop host
├── electrobun/      @makaio/electrobun      Electrobun desktop host (Bun-native)
└── cli/             @makaio/cli             Headless CLI host
```

### host-shared — The Shared Core

Both desktop hosts consume `@makaio/host-shared` for everything that is not platform-specific:

| Concern | Module | What it provides |
|---------|--------|-----------------|
| Bus contracts | `./bus` | `HostSchemas`, `HostSubjects` — window/tray RPC and events |
| Renderer bootstrap | `./renderer` | `bootstrapRenderer`, `startRenderer`, `App.tsx` — shared React root |
| Navigation | `navigation-handler.ts` | Four-tier URL → window routing (`/apps/:pkg/:window`, etc.) |
| Window session | `window-session.ts` | Cross-restart window state persistence via preferences |
| Dev host options | `dev-host-options.ts` | `MAKAIO_HOST_*` env var resolution for dev mode |
| Desktop runtime config | `desktop-runtime-config.ts` | Applies selected `makaio.config.*` discovery/defaults to desktop boot options |
| Startup env | `startup-env.ts` | Initial window resolution (`MAKAIO_INITIAL_WINDOW`, `MAKAIO_INITIAL_*` params) |
| Build tooling | `./build` | Host build helpers, workspace path resolution |

### What Differs Between Hosts

| Concern | Electron | Electrobun |
|---------|----------|------------|
| HTTP server (prod) | `@hono/node-server` | `Bun.serve()` + `hono/bun` |
| HTTP server (dev) | Vite dev server (Node) | Vite dev server (Node) + `bootMakaioRuntime` |
| Bus transport (prod) | Node `ws` | Bun-native WebSocket (`createBunWebSocket`) |
| Config to renderer | `contextBridge` + `preload.cjs` | URL query params (`?busUrl=...&bootComplete=1`) |
| Singleton policy | `app.requestSingleInstanceLock()` | Health probe + port bind (production only; dev allows multiple instances) |
| Shutdown trigger | `app.on('before-quit')` | `process.on('SIGTERM')` / `process.on('SIGINT')` |
| Window state queries | Synchronous (`win.isVisible()`) | Event-tracked proxy (`ElectrobunWindowProxy`) |
| Display matching | `screen.getDisplayMatching()` | Not available |
| Notifications | `ElectronNotificationProvider` | Stub (returns `success: false`) |
| Global shortcut | `globalShortcut` in `tray.ts` | `electrobun/bun GlobalShortcut` in `main.ts` |
| Bus handlers | Separate `bus-handlers.ts` | Inline `registerBusHandlers()` in `main.ts` |

### Boot Sequence (Shared Pattern)

Both desktop hosts follow the same logical boot sequence:

```
1. Establish singleton policy (production only in Electrobun)
2. Setup infrastructure  →  Hono app + HTTP server + /health
3. bootMakaioRuntime()   →  services, adapters, storage, extensions
4. initTrayPopover()     →  tray popover subsystem ready
5. Construct WindowManager
6. Register bus handlers (window.create, window.focus, window.list, etc.)
7. Create Tray + refresh tray entries + register shutdown handlers
8. Open initial windows (from session restore or MAKAIO_INITIAL_WINDOW)
```

Electron wraps steps 2–3 in a named `setupInfrastructure()` function; Electrobun performs the
same steps inline. The composition order and the bus subjects emitted at each stage are identical.

---

## Sync Discipline

### The Rule

**Every behavioral change to one desktop host must be reflected in the other.** If a change
cannot be reflected (missing platform API), the gap must be documented in the host-shared
layer or flagged for future parity.

### Where New Code Goes

```
Is it platform-specific?
├── Yes → Goes in the host (electron/ or electrobun/)
│         AND a matching change in the other host
└── No  → Goes in host-shared/
          Both hosts consume it automatically
```

**Examples of host-specific code:**
- `preload.cjs` (Electron's contextBridge mechanism)
- `ElectrobunWindowProxy` (compensates for missing sync state API)
- `Bun.serve()` setup (Bun-native HTTP server)

**Examples of host-shared code:**
- Bus schemas and subjects
- Renderer bootstrap and React root
- Navigation handler
- Window session persistence logic
- Descriptor and runtime-config discovery helpers

### Parity Gaps

When Electrobun lacks an API that Electron has, the gap is handled as follows:

1. **Stub it** — implement a no-op or `success: false` response so the bus contract is fulfilled
2. **Track it** — the stub should be obvious and easy to find (not buried in conditional logic)
3. **Converge later** — when Electrobun adds the API, replace the stub

Current known gaps:
- Notifications (Electrobun returns `success: false`)
- Display matching for window bounds restore
- Tray popover lifecycle (`hide()` vs `close()` on blur in WindowManager)
- Tray popover surface param (Electrobun renderer ignores `?surface=tray`, renders full shell)
- Boot error window (Electron shows error UI, Electrobun calls `process.exit(1)`)
- Renderer console forwarding (Electron-only `renderer-console.ts`)

---

## Related Documentation

- [CLI](../cli.md) — headless CLI host architecture
- [Extensions](./extensions/) — the extension model consumed by all hosts
- [Transport](./transport.md) — WebSocket bus transport used by all hosts
- [Getting Started](../getting-started.md) — first-time setup via CLI or desktop hosts
