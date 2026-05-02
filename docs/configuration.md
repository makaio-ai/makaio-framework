---
title: Configuration
description: Configure Makaio Framework applications using makaio.config.ts, makaio.config.js, or makaio.config.json with adapters, extensions, tools, and providers.
---

Makaio has separate configuration paths for runtime discovery, bootstrap
settings, and the SQLite database. They intentionally do not share one global
precedence chain.

## Runtime Config Files

Runtime config files (`makaio.config.ts`, `makaio.config.js`, or
`makaio.config.json`) control extension discovery, launcher command defaults,
and package configuration defaults.

Lookup order:

1. An explicit CLI/programmatic config path, such as root-level `--config`
2. `MAKAIO_CONFIG_FILE`
3. `$MAKAIO_HOME/makaio.config.ts`
4. `$MAKAIO_HOME/makaio.config.js`
5. `$MAKAIO_HOME/makaio.config.json`
6. Built-in defaults

Relative discovery paths inside the config file resolve from the config file
directory. When no config file is selected, default installed-extension roots
resolve under `MAKAIO_HOME`.

## Environment Variables

| Variable | Purpose | Default | Notes |
|----------|---------|---------|-------|
| `MAKAIO_HOME` | Runtime data home for config lookup, installed extensions, machine identity, and the default database path | `~/.makaio` | Blank values are ignored. |
| `MAKAIO_CONFIG_FILE` | Runtime config file override | none | Used when no explicit `--config` or programmatic config path was passed. |
| `MAKAIO_MODE` | ConfigProvider runtime mode input | `local` | Valid values: `local`, `remote`, `hybrid`. The current Node/serve host still boots in local mode; remote/hybrid runtime topology is a separate design surface. |
| `MAKAIO_BUS_URL` | Remote bus URL for clients/bootstrap config | `ws://127.0.0.1:6252/bus` for CLI clients | Use `ws://` or `wss://`. |
| `MAKAIO_BUS_SECRET` | HMAC bus secret | none | `makaio serve` uses it to require authenticated bus clients; CLI clients use it when `/health` reports `auth: true`. In `ConfigProvider`, a bus secret also requires `MAKAIO_BUS_URL`. |
| `MAKAIO_RELAY_URL` | Relay server WebSocket URL | none | Maps to effective `relay.url` in `ConfigProvider` and `ConfigSubjects.get`. `ConfigSubjects.update` does not persist this env-only value unless the same value already exists in stored config. |
| `MAKAIO_DATABASE_PATH` | SQLite database file override | `$MAKAIO_HOME/makaio.db` | Database-specific; see the precedence below. |

Bootstrap config handled by `ConfigProvider` merges in this order:

1. Default config
2. Stored config
3. Environment variables
4. Programmatic overrides

`ConfigSubjects.get` exposes the effective runtime config resolved by
`ConfigProvider`, including environment overrides. `ConfigSubjects.update`
persists only the stored config surface and strips values that came only from
environment variables, so settings screens cannot accidentally write
host-specific secrets or URLs into `config.json`.

## Database Path

The database path is resolved by the Node database initializer, not by runtime
config file precedence:

1. Programmatic `dbPath`
2. `MAKAIO_DATABASE_PATH`
3. `$MAKAIO_HOME/makaio.db`

Use `MAKAIO_DATABASE_PATH` for isolated test databases or when the SQLite file
must live outside the runtime data home.

```bash
MAKAIO_DATABASE_PATH=/tmp/e2e-test.db makaio serve --port 0
```

## Relay

Use `MAKAIO_RELAY_URL` to connect to a remote Makaio relay server for
browser-to-machine communication. If neither the environment variable nor a
bootstrap config value exists, relay connection is disabled.

```bash
MAKAIO_RELAY_URL=wss://relay.example.com makaio
```

## Adapters, Models & Providers

Adapter and provider configuration (model selection, credentials, provider
configs) is documented separately:

| Topic | Document |
|-------|----------|
| Canonical model names, provider definitions, credentials | [Models & Providers](./adapters/models-and-providers) |
| How adapters are discovered and enabled at boot | [Discovery](./adapters/discovery) |
| Available adapters and capabilities | [Adapters](./adapters/) |

Per-adapter config files live at `$MAKAIO_HOME/adapters/<adapterName>.json`.
Provider config files live at `$MAKAIO_HOME/provider-configs/<providerConfigId>.json`.

## Desktop Apps

Desktop host configuration lives under [`../apps/electron/`](../apps/electron/) and
[`../apps/electrobun/`](../apps/electrobun/) from this document. Notable paths:

| Purpose | Path |
|---------|------|
| Electron main-process runtime boot | [`../apps/electron/src/main/main.ts`](../apps/electron/src/main/main.ts) |
| Electrobun main-process runtime boot | [`../apps/electrobun/src/main/main.ts`](../apps/electrobun/src/main/main.ts) |
| Electron renderer bus URL build-time config | [`../apps/electron/vite.renderer.config.ts`](../apps/electron/vite.renderer.config.ts) |
| Electrobun renderer bus URL build-time config | [`../apps/electrobun/vite.renderer.config.ts`](../apps/electrobun/vite.renderer.config.ts) |
| Electron E2E environment overrides | [`../apps/electron/e2e/playwright.config.ts`](../apps/electron/e2e/playwright.config.ts) |
