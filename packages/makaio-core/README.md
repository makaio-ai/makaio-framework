# @makaio/core

Foundation package providing core types, errors, and context utilities. Zero internal dependencies. All other Makaio packages build on this.

## What This Is

The bedrock of Makaio Framework. Provides:

- **Context** - Execution environment (cwd, env, platform, signal, constraints)
- **Errors** - Typed error hierarchy with subject tracking
- **Types** - Subject definitions, handler signatures, message payloads, filters

## Quick Start

This is a private workspace package. Add it to a consuming workspace package with the workspace
protocol:

```json
{
  "dependencies": {
    "@makaio/core": "workspace:*"
  }
}
```

**Create an execution context:**

```typescript
import { createMakaioContext } from '@makaio/core';

const ctx = createMakaioContext({
  cwd: process.cwd(),
});
```

**Define typed handlers:**

```typescript
import type { RequestHandler, EventHandler } from '@makaio/core';

// Request handler - responds with data
const getUser: RequestHandler<{ id: string }, User> = async (ctx) => {
  const user = await db.findUser(ctx.payload.id);
  ctx.setResult(user);
};

// Event handler - fire and forget
const logEvent: EventHandler<{ message: string }> = (ctx) => {
  console.log(ctx.payload.message);
};
```

**Use discriminated unions:**

```typescript
import type { WildcardContext } from '@makaio/core';

function handler(ctx: WildcardContext<Payload, Response>) {
  if (ctx.isRequest) {
    ctx.setResult(response); // RequestContext - narrowed
  }
  // EventContext - fire and forget
}
```

## Architecture Principles

**1. Zero Dependencies** - No internal Makaio imports, pure foundation
**2. Type-First** - All contracts defined via TypeScript interfaces
**3. Discriminated Unions** - `EventContext` vs `RequestContext` via `isRequest` boolean
**4. Subject Metadata** - `SubjectDefinition.$meta` enables compile-time and runtime introspection
**5. SEAMS** - Extension points like `IConfigStorage` for future implementations

## Key Exports

### Context

| Export | Type | Description |
|--------|------|-------------|
| `MakaioContext` | Interface | Execution environment: cwd, env, platform, signal, constraints |
| `MakaioContextSchema` | Zod Schema | Runtime validation |
| `createMakaioContext(overrides?)` | Function | Factory with sensible defaults (auto-detects cwd, env, platform) |

### Errors

| Export | Extends | Description |
|--------|---------|-------------|
| `MakaioError` | Error | Base class with optional `subject` tracking |
| `InvalidModelError` | MakaioError | Invalid model specified |
| `DirectoryNotFoundError` | MakaioError | Required directory missing |
| `ConfigError` | MakaioError | Configuration validation failure |

### Types

**Subject Definitions:**
- `SubjectRecord<Keys, Payload>` - Map subject names to payloads
- `SubjectDefinition<Subject, Key, Namespace>` - Full subject metadata with `$meta`
- `SubjectDefinitionRecord<Subjects, Namespace>` - All definitions in a namespace

**Handler Contexts:**
- `EventContext<Payload>` - Handler context for events (`isRequest: false`)
- `RequestContext<Payload, Response>` - Handler context with `setResult()`, `next()`
- `WildcardContext<P, R>` - Union type - narrows via `if (ctx.isRequest)`

**Handler Signatures:**
- `EventHandler<T>` - Fire-and-forget handler for one-way events
- `RequestHandler<Payload, Response>` - Handler with `setResult()` capability
- `WildcardUnifiedHandler` - Matches both events and requests
- `HandlerForSubjectDefinition<T>` - Resolves correct handler from definition

**Messages:**
- `BaseMessageContext` - Common metadata: `messageId`, `correlationId`, `isRequest`
- `EventMessagePayload<P>` - Event payload wrapper
- `RequestMessagePayload<Req, Res>` - Request/response payload wrapper

**Filtering:**
- `PayloadFilter` - Untyped filter with operators
- `TypedPayloadFilter<T>` - Type-safe filter using dotted paths
- `FilterOperator<T>` - Operators: equality, `$in`, `$ne`, `$exists`

**Storage (SEAM):**
- `IConfigStorage<TConfig>` - Extension point for config persistence

## Design Philosophy

**"Foundation without opinion"** - Provides the building blocks and contracts that all Makaio packages depend on, without dictating implementation details. Extension points (SEAMS) allow future implementations to slot in without refactoring.

---

*Part of Makaio Framework*
