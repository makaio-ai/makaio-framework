# @makaio/bus-server-vite

Vite plugin that starts the full Makaio Node.js runtime alongside the Vite dev
server. The browser connects to backend services over a WebSocket bus endpoint
(`/bus`) that shares Vite's HTTP port, so no second port is required during
development.

## Usage

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ViteBusServerPlugin } from '@makaio/bus-server-vite';

export default defineConfig({
  plugins: [
    react(),
    ViteBusServerPlugin({
      secret: process.env['BUS_SECRET'],
      debug: true,
    }),
  ],
});
```

The runtime initializes after Vite's HTTP server binds its port. Bus handlers
become routable progressively as each service starts — Vite's HTTP serving is
never blocked.

## API Overview

| Export | Description |
|--------|-------------|
| `ViteBusServerPlugin()` | Creates the Vite plugin; accepts `ViteBusServerPluginOptions` |
| `createViteRuntimeBootOptions()` | Builds the `BootMakaioRuntimeOptions` passed to `bootMakaioRuntime`; useful for testing |
| `type ViteBusServerPluginOptions` | `secret`, `debug`, and `runtimeOptions` fields |

### `ViteBusServerPluginOptions`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `secret` | `string` | `undefined` | HMAC shared secret. Omit for dev mode (no auth). Must be non-empty if set. |
| `debug` | `boolean` | `false` | Log extension lifecycle events and runtime startup to stdout. |
| `runtimeOptions` | `Pick<BootMakaioRuntimeOptions, 'discovery' \| 'frameworkVersion' \| 'hostCapabilities'>` | `undefined` | Host-configurable subset forwarded to `bootMakaioRuntime`. |

## Key Concepts

- **Lifecycle**: the plugin attaches once Vite's `httpServer` emits `listening`,
  then starts the runtime in the background via `bootMakaioRuntime`. On
  `closeBundle` (build finish or process exit) the plugin waits up to 10 seconds
  for the runtime to shut down cleanly.
- **Transport**: the runtime registers a raw WebSocket upgrade handler on the
  Node HTTP server at path `/bus`, sharing the same port as Vite's dev server.
- **HMAC auth**: when `secret` is provided a `HmacAuth` strategy is passed to
  the WebSocket transport; omit it to skip authentication in development.

## Installation

`@makaio/bus-server-vite` is a private workspace package. It requires `vite`
as a peer dependency:

```json
{
  "@makaio/bus-server-vite": "workspace:*",
  "vite": "^8.0.0"
}
```

---

*Part of the [Makaio AI Framework](../../README.md)*
