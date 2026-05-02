# @makaio/services-core/capability

Push-based capability provider registry with bus-native discovery and validation.

## What This Is

- **Registry service** for capability providers registered by extensions
- **Push-based architecture** - extension services register providers via bus events, not pull-based extraction
- **Generic operations** - register/unregister providers, list providers, and validate providers
- **Foundation layer** - domain services (push-notification, etc.) build on top of this

## Quick Start

```typescript
import { MakaioBus } from '@makaio/bus-core';
import { CapabilityService } from '@makaio/services-core/capability';
import { CapabilitySubjects } from '@makaio/contracts';

// 1. Initialize service
const capabilityService = new CapabilityService(MakaioBus);
await capabilityService.init();

// 2. Extensions register providers via bus events
MakaioBus.emit(CapabilitySubjects.register, {
  capabilityId: 'push-notification',
  provider: myProvider,  // implements ICapabilityProvider
});

// Extensions unregister providers that are no longer available
MakaioBus.emit(CapabilitySubjects.unregister, {
  capabilityId: 'push-notification',
  providerId: myProvider.id,
});

// 3. Query registered providers
const providers = capabilityService.getProviders('push-notification');

// 4. Or via bus request
const { providers } = await MakaioBus.request(CapabilitySubjects.listProviders, {
  capabilityId: 'push-notification',
});

// 5. Validate all providers for a capability
const { results } = await MakaioBus.request(CapabilitySubjects.validate, {
  capabilityId: 'push-notification',
});

// Cleanup
await capabilityService.destroy();
```

## Architecture Principles

### Push vs Pull Registration

**Before (pull-based):**
```
Runtime → extractCapabilities(extension) → CapabilityCoordinator
```

**After (push-based):**
```
MakaioExtension.create() → service.init() → bus.emit(register) → CapabilityService
```

Extension services own their registration. The runtime creates and initializes the service; the
service emits registration events and unregisters providers during teardown.

### Layered Services

```
┌─────────────────────────────────────────────────────────────┐
│ Domain Services (PushNotificationService, etc.)             │
│   Handle domain-specific logic (routing, orchestration)     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ CapabilityService (this package)                            │
│   Generic registry: register, list, validate                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ @makaio/contracts - ICapabilityProvider, CapabilitySubjects  │
│   Type contracts and bus subjects                           │
└─────────────────────────────────────────────────────────────┘
```

## Key Exports

### Types

| Export | Source | Description |
|--------|--------|-------------|
| `ICapabilityProvider` | `@makaio/contracts` | Base interface for all providers |
| `ProviderRegistration` | `@makaio/contracts` | Registration payload type |
| `ProviderUnregistration` | `@makaio/contracts` | Unregistration payload type |

### Classes

| Export | Description |
|--------|-------------|
| `CapabilityService` | Main registry service with bus handlers |

### Bus Subjects (from @makaio/contracts)

| Subject | Type | Description |
|---------|------|-------------|
| `capability.register` | Event | Register or replace a provider |
| `capability.unregister` | Event | Remove a provider |
| `capability.listProviders` | Request | List providers for a capability |
| `capability.validate` | Request | Validate all providers for a capability |

## Design Philosophy

### Single Responsibility

CapabilityService handles only generic registry operations:
- Register providers
- Unregister providers
- List providers by capability
- Validate provider credentials

The bus surface is limited to `capability.register`, `capability.unregister`, `capability.listProviders`, and
`capability.validate`. The service also exposes in-process helpers such as `getProviders()`, `hasProviders()`, and
`getCapabilities()` for composition roots that already hold the service instance.

Domain-specific logic (routing notifications, managing enabled state) belongs in domain services.

### Decoupled from Extensions

The service knows nothing about specific extensions. It receives providers via bus events and stores them by capability ID. This allows:
- Extensions to be loaded/unloaded dynamically
- Multiple extensions to provide the same capability
- Testing without loading actual extensions

### Type Safety via Typed Helpers

Provider registration uses `z.unknown()` at the Zod level (runtime objects with methods cannot be validated by Zod). Type safety is enforced by:
- `ICapabilityProvider` interface in contracts
- Domain-specific interfaces (e.g., `IPushNotificationProvider`) extending the base

---

*Part of the [Makaio AI Framework](https://github.com/makaio-ai/makaio-framework)*
