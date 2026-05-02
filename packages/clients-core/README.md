# @makaio/clients-core

Framework package for managing external client binaries (e.g. Claude Code CLI),
their installation lifecycle, version resolution, and runtime registry. Also
provides the wiring helpers and bus subjects that connect client sessions to the
Makaio session model.

## Usage

### Register the package in the composition root

```typescript
import { createClientsCorePackage } from '@makaio/clients-core';

const clientsCoreExt = createClientsCorePackage({
  definitions: clientDefinitions,
});
coordinator.load([clientsCoreExt]);
```

### Install and manage a client binary

```typescript
import { ClientBinaryManager } from '@makaio/clients-core';

const manager = new ClientBinaryManager(bus, config, registry, strategyDependencies);
await manager.install('claude-code', { source: 'npm' });
const binary = await manager.resolve('claude-code');
```

### Listen for client hook events

```typescript
import { ClientSubjects } from '@makaio/clients-core';

MakaioBus.on(ClientSubjects.hookReceived, ({ payload }) => {
  console.log('Hook from', payload.clientId, payload.event);
});
```

## API Overview

| Export | Description |
|--------|-------------|
| `ClientsCoreService` | Service class — registers bus handlers for binary management and session wiring |
| `ClientsCoreToken` | Extension token for retrieving the service |
| `createClientsCorePackage()` | Factory for the `MakaioExtension` manifest |
| `ClientBinaryManager` | Orchestrates binary download, versioning, and disk layout |
| `ClientBinaryJobRunner` | Executes install/uninstall jobs with progress callbacks |
| `ClientBinaryFeedCache` | Cache layer for version feed responses |
| `ClientBinaryVersionResolver` | Fetches latest available version from a feed |
| `ClientDefinitionRegistry` | In-memory registry of known client definitions |
| `ClientRuntimeRegistry` | Persistent registry of running client instances |
| `ClientRuntimeService` | Service that owns the `ClientRuntimeRegistry` bus handlers |
| `ClientAccountRegistry` | Maps accounts to client credentials |
| `ClientSubjects` | Bus subjects for hook events and binary state changes |
| `ClientBinaryStorageNamespace` / `ClientBinaryStorageSubjects` | Storage CRUD subjects for binary state |
| `ClientRuntimeStorageNamespace` / `ClientRuntimeStorageSubjects` | Storage CRUD subjects for runtime records |
| `atomicModifyFile()` | Atomic read-modify-write for config files |
| `resolveClientBinary()` | Resolve the absolute path to an installed binary |
| `buildClientCommand()` / `buildHookCommand()` | Build CLI invocation arrays from wiring entries |
| `deriveSessionEventDescriptors()` | Map session lifecycle events to hook command descriptors |
| `createClientNamespace()` | Register a typed bus namespace for a specific client |
| `createClientWiringSubjectDef()` / `createClientWiringListSubjectDef()` | Subject definition helpers for client wiring |
| `BinaryNotFoundError` | Typed error thrown when a binary is not installed |
| Wiring schemas (`ClientWiringEntrySchema`, etc.) | Zod schemas for client wiring CRUD operations |

## Installation

`@makaio/clients-core` is a private workspace package:

```json
{ "@makaio/clients-core": "workspace:*" }
```

---

*Part of the [Makaio AI Framework](../../README.md)*
