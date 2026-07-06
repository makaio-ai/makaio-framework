# @makaio/services-core

The largest framework package: 30+ domain service namespaces, storage handlers,
orchestration logic, and extension packages for the Makaio framework's core
runtime. Everything from sessions, turns, and agents to model registry, tool
approval, subagent templates, and execution targets lives here.

## Installation

`@makaio/services-core` is a private workspace package:

```json
{ "@makaio/services-core": "workspace:*" }
```

## Usage

Import the root barrel for the most-used exports, or use the granular sub-path
exports to keep bundle sizes small and side-effect-free.

```typescript
// Root barrel — includes all runtime logic
import {
  SessionOrchestrator,
  ToolRegistry,
  ModelRegistryService,
} from '@makaio/services-core';

// Sub-path — only loads the session domain
import { MakaioSession, SessionStorageNamespace } from '@makaio/services-core/session';

// Register the namespace bus side effects
import '@makaio/services-core/session/storage/namespace';
```

### Compose extension packages

```typescript
import {
  frameworkCorePackages,
  sessionOrchestratorPackage,
  toolRegistryPackage,
  createModelRegistryPackage,
} from '@makaio/services-core';

coordinator.load([
  ...frameworkCorePackages({ bus, db }),
  createModelRegistryPackage({ bus, fetcher }),
]);
```

## Domain Namespaces

Each domain exposes bus subjects (RPCs and events), Zod schemas, Drizzle
storage schemas, and a set of runtime helpers. The table below lists the
major domains:

| Sub-path | Domain | Key exports |
|----------|--------|-------------|
| `./session` | Session lifecycle | `MakaioSessionService`, `SessionOrchestrator`, `SessionBridge`, sessions/agents/turns/messages tables |
| `./session/storage/namespace` | Session storage bus | `SessionStorageNamespace`, `SessionStorageSubjects` |
| `./session/turns/namespace` | Turn storage | `TurnStorageNamespace`, `TurnStorageSubjects` |
| `./session/messages/namespace` | Message storage | `MessageStorageNamespace`, `MessageStorageSubjects` |
| `./session/session-events/namespace` | Session event storage | `SessionEventStorageNamespace`, `SessionEventStorageSubjects` |
| `./tools` | Tool registry | `ToolRegistry`, `createToolContributionProcessor` |
| `./capability` | Capability negotiation | `CapabilityService` |
| `./tool-approval` | Tool approval flow | `ToolApprovalService` |
| `./model-registry` | Model registry | `ModelRegistryService`, `CachedRegistryFetcher`, `FallbackRegistryFetcher` |
| `./canonical-model/namespace` | Default model resolution | `CanonicalModelNamespace`, `CanonicalModelSubjects` |
| `./adapter-runtime` | Adapter identity | `AdapterIdentityRegistry`, `AdapterRuntimeSubjects`, `buildDeterministicAdapterId` |
| `./adapter-runtime/namespace` | Adapter runtime bus | `AdapterRuntimeNamespace` (side-effectful) |
| `./adapter-subsystem` | Adapter config | `IAdapterConfigRepository` |
| `./agent-runtime` | Agent instance status | `AgentRuntimeSubjects`, `AgentRuntimeNamespace` |
| `./execution-target` | Container/local targets | `ExecutionTargetSubjects`, spawn/stop/status RPCs, Docker subjects |
| `./subagent-template` | Subagent templates | `SubagentTemplateSubjects`, `SubagentTemplateSchema`, template CRUD |
| `./codebase` | Codebase change events | `CodebaseSubjects`, `CodebaseChangedEventSchema` |
| `./compression` | Context compression | `CompressionSubjects`, `CompressRequestSchema` |
| `./preferences` | User preferences | `PreferencesSubjects`, `PreferenceItemSchema` |
| `./settings` | Settings storage | `SettingsService`, settings-related storage namespaces |
| `./tray-menu` | System tray menu | `TrayMenuService`, `TrayMenuSubjects`, menu entry schemas |
| `./turn` | Turn domain | `TurnStorageNamespace`, turn schemas |
| `./context-rules` | Context rule evaluation | Context rule helpers |
| `./definition` | Adapter definitions | `DefinitionSubjects`, definition schemas |
| `./local-notification` | OS notifications | `LocalNotificationSubjects`, notification schemas |
| `./dialog/namespace`, `./dialog/schemas` | Modal dialogs | `DialogSubjects`, dialog schemas |
| `./filesystem/namespace`, `./filesystem/schemas` | Filesystem ops | `FilesystemSubjects`, filesystem schemas |
| `./provider-context` | Provider context | `activateProviderContext`, `activateProviderContextStrict` |
| `./provider-runtime` | Provider runtime | Provider runtime helpers |
| `./harness` | Test harness storage | `HarnessService`, harness Drizzle schema |

## Key Extension Packages

| Export | Token | Description |
|--------|-------|-------------|
| `sessionPackage` | `SessionToken` | Session storage handlers |
| `sessionOrchestratorPackage` | `SessionOrchestratorToken` | `SessionOrchestrator` + session bridge |
| `sessionBridgePackage` | `SessionBridgeToken` | `SessionBridge` service |
| `sessionStoragePackage` | `SessionStorageToken` | Registers all Drizzle session storage handlers |
| `toolRegistryPackage` | `ToolRegistryToken` | `ToolRegistry` + contribution processor |
| `toolApprovalPackage` | `ToolApprovalToken` | `ToolApprovalService` |
| `createModelRegistryPackage()` | `ModelRegistryToken` | `ModelRegistryService` with injected fetcher |
| `capabilityPackage` | `CapabilityToken` | `CapabilityService` |
| `trayMenuPackage` | `TrayMenuToken` | `TrayMenuService` |
| `frameworkCorePackages()` | — | Convenience factory returning all framework-critical extension packages |
