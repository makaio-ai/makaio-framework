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
3. `$MAKAIO_HOME/makaio.config.ts` / `.js` / `.json`
4. `./makaio.config.{ts,js,json}` in the working directory — non-production
   builds only, when the working directory differs from `$MAKAIO_HOME`
5. Built-in defaults

Relative discovery paths inside the config file resolve from the config file
directory. When no config file is selected, default installed-extension roots
resolve under `MAKAIO_HOME`.

## Operator Extension Config

Each extension can be configured individually through a JSON file at
`$MAKAIO_HOME/config/extensions/<encoded-name>.json` (defaulting to
`~/.makaio/config/extensions/<encoded-name>.json`). The file body is the
extension's own config object exactly as its `configSchema` validates it — no
outer envelope, no `$schema` field, plain JSON.

**File naming.** The file stem is the extension's manifest name with
percent-encoding applied to every character outside `[A-Za-z0-9._-]`. Unreserved
characters are kept as-is; everything else becomes `%XX` in uppercase. A leading
`.` is escaped as well, so the file is never hidden from the operator editing
it. Examples:

| Extension name | File |
|---|---|
| `gateway` | `gateway.json` |
| `com.example.tools` | `com.example.tools.json` |
| `@acme/weather-tools` | `%40acme%2Fweather-tools.json` |
| `.hidden` | `%2Ehidden.json` |

The encoded file name is limited to 255 bytes, the per-component limit of the
filesystems a Makaio home lives on. Percent-encoding expands one non-ASCII
character to up to twelve, so a name of about 40 non-ASCII characters can exceed
it. Such an extension loads and runs, but has no operator config file at all;
boot says so once, and the other configuration layers still apply to it.

**Precedence** — four layers, lowest to highest:

1. `descriptor.json` `config.defaults` (extension author baseline).
2. `packageConfigDefaults` in the runtime config file (`makaio.config.*`) or host
   composition root.
3. Stored extension-config records — supplied by a host that wires an
   `ExtensionConfigProvider`; no host ships one today, so this layer is currently
   inert; the kernel contract is what is specified here.
4. Operator config file — highest; wins on every top-level key it declares.

Merging is **shallow, one level**: an operator file that declares a nested object
(such as `upstreams`) replaces that entire object from lower layers rather than
merging into it. Specify complete values for any nested object you configure.

**Lifecycle.** The directory is scanned once during host boot; files are not
watched. Edits after boot have no effect until the host is restarted —
disabling and re-enabling resolves against the same boot-time snapshot.

**Diagnostics:**

| Condition | Behaviour |
|---|---|
| Absent `config/extensions/` directory | Nothing — no warning, no directory created |
| Unreadable directory (other than absent) | Boot fails with the path and error code |
| File name does not end in `.json`, or its stem is not a canonical percent-encoded name | Boot warning naming the file; file is ignored |
| File name with a leading dot | Skipped silently: an encoded stem never starts with a dot, so such an entry is editor or platform bookkeeping (`.DS_Store`, `.#gateway.json`) rather than something an operator wrote. The file for an extension named `.hidden` is `%2Ehidden.json` |
| Entry that is not a regular file — a directory, FIFO, socket, or device, or a symlink to one | Treated as unreadable without being opened; extension activation fails with the file path in the error. A symlink to a regular file is followed and read |
| File that is not valid UTF-8 | Treated as invalid JSON; extension activation fails with the file path in the error. The bytes are never repaired into a usable object |
| File saved with a leading byte-order mark | Accepted: the mark is consumed before parsing, so a file an editor saved as "UTF-8 with BOM" is not reported as invalid JSON over a byte it does not show |
| Two file names that differ only in case (observable only on a case-sensitive filesystem, where both files coexist) | Boot warning naming both candidate file names and both decoded extension names; both are kept and each reaches its own extension. It is a portability notice: copied onto a case-insensitive filesystem the home would hold only one of them |
| File above 1 MiB | Treated as unreadable; extension activation fails with the file path in the error |
| Unreadable file, invalid JSON, or top-level value is not an object | Extension activation fails with the file path in the error; non-critical extensions fail alone without aborting boot |
| Merged config is rejected by the extension's `configSchema` while an operator file is present | Extension activation fails with the file path and the schema issue in the error, rather than falling back to schema defaults — even when a lower layer supplied the rejected value, since the file is the input an operator can act on. Without an operator file the pre-existing behaviour is unchanged: a warning, then the schema's own defaults |
| File names a loaded extension without a `configSchema` | Boot warning naming the file; config is never applied; a *malformed* file (invalid JSON etc.) for such an extension still fails that extension's activation |
| File names an extension that is not loaded | Boot warning naming the file and the decoded extension name; never fatal. "Loaded" means what the extension coordinator actually retained, so a file for an extension this surface excludes is reported rather than silently dropped |
| Loaded extension whose encoded file name would exceed 255 bytes | Boot warning naming the extension; it cannot be configured by file, and no file name would work |

**Relation to `makaio.config.*`.** Runtime config files control extension
discovery, launcher commands, and `packageConfigDefaults` (layer 2 above). The
operator file targets a single extension and sits above that layer. The two are
independent: you do not need a runtime config file to use an operator file, and
selecting a different runtime config file for discovery does not affect operator
files.

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
| Canonical model names, provider definitions, credentials | [Models & Providers](./architecture/adapters/models-and-providers) |
| How adapters are discovered and enabled at boot | [Discovery](./architecture/adapters/discovery) |
| Available adapters and capabilities | [Adapters](./architecture/adapters/) |

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
