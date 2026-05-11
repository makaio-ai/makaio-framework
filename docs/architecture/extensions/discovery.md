---
title: Discovery & Loading
description: How extensions are discovered, loaded, configured, and wired into the runtime.
---

Extension discovery is descriptor-driven. `ExtensionCoordinator` loads
`MakaioExtension` objects discovered through the `ExtensionDiscovery` strategy selected by
the host composition root; adapter, provider, client, and extension contributions are read
from loaded extension manifests and wired by contribution processors.

## Extension discovery

All extensions are descriptor-backed runtime artifacts. Once selected, they use the same
loading and coordinator pipeline.

| Mode | Discovery strategy |
|------|--------------------|
| Default boot | `FilesystemDescriptorDiscovery` — scans descriptor roots supplied by boot options/runtime config |
| Host override | Custom `ExtensionDiscovery` passed through `CoreBootOptions.discovery` |
| Testing | `ExplicitDescriptorDiscovery` or direct injection into `ExtensionCoordinator.load()` |

The default filesystem discovery can scan local `node_modules/`, installed extension roots,
and global npm roots with **local > installed > global-npm** precedence. Runtime config can replace
the discovery roots and apply include/exclude filters before boot. `MergedDescriptorDiscovery`
layers multiple discovery sources with constructor-order priority when the composition root
configures several strategies.

Without an explicit discovery override, the framework default scans local `node_modules/`
plus installed-extension roots under the resolved Makaio home (`extensions/` and
`node_modules/`) with local results taking priority. Runtime config (`makaio.config.*`) can
replace discovery paths and apply include/exclude filters. There is no architectural
distinction between selected extensions — all go through the same descriptor-backed pipeline.

## Loading pipeline

Extensions go through a multi-stage pipeline before reaching the coordinator:

1. **Discovery** (`extension-discovery.ts`) — scans filesystem locations for `descriptor.json`
   files with configurable precedence.
2. **Loading** (`load-extensions.ts`) — dynamically imports server entry modules via `import()`,
   validates them. Path containment checks prevent traversal attacks from malicious
   descriptors.
3. **Browser bridging** (`bridge-extension-browser-entries.ts`) — augments loaded extensions
   with browser entry URLs and HTTP serving fields so their UI bundles are accessible.
4. **Browser-only synthesis** (`synthesize-browser-only-packages.ts`) — creates minimal
   manifest-only `MakaioExtension` wrappers for extensions that only have a browser entry
   and no server code.

## Config resolution

When an extension declares a `configSchema` (Zod), the runtime resolves config before calling
`create()`. `resolve-config.ts` merges descriptor defaults with stored config and parses
through the schema. The resolved config is passed via `ExtensionContext.config`. Parse failures
are non-fatal — a warning is logged and the schema is re-parsed with an empty object.

## Contribution discovery

Adapters, providers, clients, tools, triggers, log importers, session event
actions, and extension metadata are extension contributions. The runtime does not
run separate filesystem discovery classes for those surfaces; it loads
descriptor-backed extensions first, then contribution processors wire the active
extension manifests during coordinator start/stop.

**Contribution processor availability:** The framework boot sequence (`boot.ts`)
registers contribution processors for framework-owned surfaces such as adapters,
log imports, and tools. Domain-specific surfaces, such as triggers and session
event actions, are installed by descriptor-selected extensions through typed
`MakaioExtension.runtimeBoot` seams. `MakaioExtension.runtimeOwnership` declares
single-owner runtime responsibilities, such as replacing the framework session
orchestrator. Extensions may supply these processors, but they do not create a separate
application runtime mode. A runtime may load an extension whose declared
contribution surface has no registered processor; in that case the extension can still
become active, but the missing surface is not wired until the owning extension supplies
the processor. This is a descriptor/config selection concern.

<!-- web:hide -->

## Key source files

| File | Purpose |
|------|---------|
| `../runtimes/node/src/extension-discovery.ts` | Descriptor extension filesystem scanning |
| `../runtimes/node/src/load-extensions.ts` | Dynamic import + validation of extensions |
| `../runtimes/node/src/bridge-extension-browser-entries.ts` | Browser entry augmentation for extensions |
| `../runtimes/node/src/synthesize-browser-only-packages.ts` | Manifest-only extensions for browser-only descriptors |
| `../packages/kernel/src/extension/resolve-config.ts` | Extension config resolution (schema + defaults) |

<!-- /web:hide -->
