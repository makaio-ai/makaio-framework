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

## Extension Enablement

Each extension can be individually disabled or re-enabled without uninstalling
it. The framework owns a single JSON file that records which extensions have
been explicitly disabled:

```
$MAKAIO_HOME/config/extensions.json
```

### File shape

The file is hand-editable. It contains a `"disabled"` array of extension
package names. An absent name means the extension is enabled (the default).
Only disabled names are stored, so the file stays small and self-cleaning:

```json
{
  "disabled": ["com.example.heavy-ext", "linear"]
}
```

An empty file or a file without a `"disabled"` key has no effect — all
extensions start enabled. Duplicate names in the array are harmless.

### CLI

```bash
# Enable or disable — always persisted; effective on the next process restart
makaio extension enable <name>
makaio extension disable <name>

# List installed extensions with enablement state
# Queries the running server when reachable; falls back to the file when offline
makaio extension list
```

When a server is reachable, the whole listing comes from that server: its live
snapshot (`kernel:extension.list`) merged with the packages it has installed
but never loaded (`kernel:extension.catalog`). Both halves describe the same
host, so the listing is equally complete for a local and a remote bus, and it
covers discovery roots no client can see — another machine's install tiers, or
the roots a server configured for itself relative to the directory it was
started from. This machine's own installs are never spliced in. A server wired without an installed-extension
catalog reports that fact, and the command notes it rather than filling the gap
with a different host's view.

When a server is reachable, every toggle is likewise the server's decision: the
CLI forwards the request to `kernel:extension.setEnabled`, which validates it
against the extensions that server loaded or — for a name it never loaded —
against its own installed-extension catalog, and then writes its own enablement
file. The CLI never writes anything itself while a server is reachable, not even
for a loopback bus: a local server can have been started from a different
project directory, so this process's installed packages are not a reliable
stand-in for its own.

`setEnabled` is persist-only: it durably records the preference but never
applies it to the running process, because several package contributions are
composed exactly once at boot and cannot be replayed for one package in
isolation. The command reports precisely what happened:

- **"Persisted; the running server's process already matches this state."** —
  the process's current runtime state already matches the request, so no
  restart is needed for it to keep being true.
- **"Persisted; no running server — takes effect on next boot."** — no local
  server was reachable, so the CLI wrote the file itself after confirming the
  name is actually installed (see
  [Offline discovery precedence](#offline-discovery-precedence)); start the
  server to activate.
- **"Persisted; the running server's process is not in the requested state.
  Takes effect on next boot."** — the server persisted the preference, but its
  runtime state diverges from it (for example enabling a `runtimeOwnership`
  extension that was never started this boot). Restart to activate it.
- **"Persisted; not loaded in the running server (interactive-only, unmet
  requirements, or MAKAIO_SKIP_EXTENSIONS)."** — the package is installed on the
  server's host but that server never loaded it into its coordinator. The server
  validated the name against its own installed-extension catalog and recorded
  the preference; an enable additionally reports that it takes effect on the
  next boot.
- **"Persisted; a framework package currently holds this name..."** — a
  framework package is loaded under the requested name, so the installed package
  behind it stays shadowed until that package no longer claims the name. The
  preference is recorded regardless.
- **"the running server is shutting down. Nothing was written."** — the request
  reached a coordinator that is tearing down. The command exits non-zero.
- **"the request was rejected. Nothing was written."** — the request was
  refused for a reason the server did not name. The command exits non-zero.
- **"request failed: \<reason\>. Nothing was written locally..."** — the RPC
  itself failed (a transport error). The command exits non-zero.
- **"the running server has not loaded this extension and cannot enumerate its
  installed packages..."** — the server exposes no installed-extension catalog,
  so it cannot tell a real installed name from a typo and refuses rather than
  persisting on the caller's word. Nothing is written, and the command exits
  non-zero.
- **"the configured server at \<url\> is unreachable; retry when it is up, or
  run this command on that host."** — `MAKAIO_BUS_URL` names a remote host and
  the health probe found nothing there. The CLI never falls back to writing
  this machine's enablement file in this case: that file is only the one a
  *local* server would read, and offline-writing it here would silently record
  a preference the configured remote host never sees. The command exits
  non-zero without writing anything.
- **"no installed extension with this name. Run \"makaio extension list\" to
  see installed extensions."** — nothing on the deciding host has this name
  installed (a typo). Whichever side made the decision — the reachable server
  for its own host, or this process when none is reachable — nothing is
  written, and the command exits non-zero.

A server that answers the health probe but cannot be connected to fails the
command without writing anything, so the file is never left ahead of a server
whose state is unknown.

#### Offline discovery precedence

Every offline check above — the critical-extension refusal, the "is this name
installed" validation, and `makaio extension list`'s offline listing — reads
the installed-package view produced by *the discovery this invocation resolved*,
never a separate tier list of its own. A host that declares
`extensions.discoveryPaths`, `include`, or `exclude` therefore sees exactly the
descriptors its next boot would consider: nothing it would load is reported
not-installed, and nothing it filtered out is offered as toggleable.

With no `discoveryPaths` declared, that discovery is the data home's two
default roots:

1. `$MAKAIO_HOME/extensions` — locally symlinked installs
2. `$MAKAIO_HOME/node_modules` — npm installs

A host that boots its own discovery — the programmatic `bootMakaioRuntime`
default, or an explicitly supplied strategy — additionally prioritizes
`{cwd}/node_modules`, the dependencies of the project it was started from,
above both. An invocation that resolved no discovery at all (a host that built
the command tree without runtime config, and therefore hands `serve` no boot
discovery either) gets that same three-tier default offline: the project-local
tier leads, ahead of whatever the config file resolves to.

The standalone CLI is not such a host — it resolves runtime config before it
builds its command tree, and hands `serve` the very same discovery. So with no
`discoveryPaths` declared, an extension present only in the invoking project's
`node_modules` is neither listed nor toggleable offline, because a `makaio
serve` started in that directory would not load it either. Declare
`extensions.discoveryPaths: ['node_modules']` to opt that tier in; boot and the
offline paths pick it up together.

A name found in an earlier root shadows the same name in every later one, so an
override of an otherwise-installed extension — including its `critical` flag —
is what the offline paths above see, exactly as a locally started server would
only ever load one of the two.

A reachable server answers the equivalent *live* questions from its own
discovery, rooted at its own working directory and data home — which is why a
live listing and a live toggle can address packages this process cannot see at
all.

#### Offline listing of executable child packages

A single installed descriptor can export more than one executable package
from its server entrypoint — for example a descriptor that also registers a
dot-prefixed sub-extension. `makaio extension list` discovers these child
packages even when no server is reachable: for each installed descriptor it
dynamically imports the already-resolved server entrypoint and normalizes its
default export the same way the runtime does at boot, without invoking any
package's `create()`. Each child package gets its own row, addressed by its
own name, right after the descriptor's own entry.

`makaio extension enable <name>` and `makaio extension disable <name>` accept
these same child-package names, both online and offline: the enablement file
is keyed by executable package name, not by descriptor name, so a
dot-prefixed sub-extension can be toggled independently of the descriptor
that exports it and keeps its persisted preference visible after the server
that loaded it stops.

### Evaluation order

Enablement is determined by the following mechanisms, in the order they are applied:

1. **Default** — all extensions are enabled unless something overrides them.
2. **`MAKAIO_SKIP_EXTENSIONS`** — a comma-separated list of extension names excluded
   at _discovery_ before the coordinator or the enablement file sees them. Extensions
   suppressed this way are absent from the coordinator entirely until the variable
   is removed and the process restarts.
3. **Enablement file** — `$MAKAIO_HOME/config/extensions.json`; names in
   `"disabled"` start in `skipped` state and become effective on the next process
   restart.
4. **Surface and runtime-environment filter** — extensions that declare an
   incompatible surface (e.g. `interactive`-only on a headless server) or unmet
   `requires` are skipped regardless of the enablement file. This is independent
   of the above steps and cannot be overridden at runtime.

`MAKAIO_SKIP_EXTENSIONS` acts at the discovery phase and is not overridable by the
enablement file. An extension in both `MAKAIO_SKIP_EXTENSIONS` and the enablement
file's `"disabled"` list is simply absent — the file entry is inert.

### Critical extensions

Extensions marked `critical: true` cannot be disabled via the
`kernel:extension.setEnabled` bus RPC — the toggle is refused, with a `reason` of
`critical` on the response, and nothing is written.
If a critical extension is listed in `"disabled"` anyway (a hand-edited file), boot
starts it regardless and emits a console warning on every boot.

`makaio extension disable <name>` therefore refuses a critical extension before
writing anything, and exits non-zero. A reachable server resolves the flag itself
— from the extension it loaded, or from its installed-extension catalog for one
it did not — and refuses the request as a response the command renders; offline,
this process resolves it from its own installed listing. `makaio extension list`
applies the same rule, so a critical extension that is present in `"disabled"` is
reported as `enabled` — which is what boot does with it.

Criticality resolution — on the server for its own host, or in this process when
none is reachable — reads the same exported package the runtime would act on, not
`descriptor.json`, for any descriptor that declares a `server` entrypoint: it
dynamically imports the already-resolved server entrypoint and reads `critical` off
the exported package matching the descriptor name, the same normalization
`normalizePackageExport` applies at boot. `descriptor.json` must not declare
`critical` itself in that case — `ExtensionDescriptorSchema` rejects the combination
at discovery, install, and verify, because a server entrypoint can export several
packages, each with its own criticality. When the entrypoint cannot be imported or
its export does not resolve to a valid package, resolution fails closed to
*unknown* rather than guessing — `makaio extension disable` then refuses the
extension rather than risk disabling one that turns out to be critical, and `makaio
extension list` reports it accordingly.

Only a descriptor *without* a server entrypoint (detached, CLI-only, browser-only)
has no exported package for the runtime to read; there, the descriptor's own
`critical` field in `descriptor.json` *is* that synthesized package's flag, and is
the value used directly.

### Diagnostics

| Condition | Behaviour |
|-----------|-----------|
| File absent | Silent; all extensions enabled |
| Path exists but is not a regular file | Warning at boot; treated as all-enabled |
| File above 1 MiB | Warning at boot; treated as all-enabled |
| File is not valid JSON | Warning at boot; treated as all-enabled |
| File is not a JSON object | Warning at boot; treated as all-enabled |
| `"disabled"` is not a string array | Warning at boot; treated as all-enabled |
| Critical extension in `"disabled"` | Warning at boot; extension starts anyway |

## Environment Variables

| Variable | Purpose | Default | Notes |
|----------|---------|---------|-------|
| `MAKAIO_HOME` | Runtime data home for config lookup, installed extensions, machine identity, and the default database path | `~/.makaio` | Blank values are ignored. |
| `MAKAIO_SKIP_EXTENSIONS` | Comma-separated list of extension names to suppress at boot regardless of the enablement file | none | Applied before surface/environment filtering; useful for CI or debugging without uninstalling. Example: `MAKAIO_SKIP_EXTENSIONS=linear,com.example.ext` |
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
