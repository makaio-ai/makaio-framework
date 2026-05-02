# Hooks

Typed interceptors for MakaioBus message lifecycle.

## What This Is

Middleware system for intercepting bus messages at named lifecycle points. Provides:

- **Named Hooks** - `PreUserMessage`, `PostTurn`, etc. with enriched context
- **BusMessage** - Generic escape hatch for any subject
- **Session Enrichment** - Auto-fetches session, recent turns, and optional host-contributed context extensions
- **Context Injection** - Pass data downstream via `setTurnContext()`

## Quick Start

This is a private workspace package. Add it to a consuming workspace package with the workspace
protocol:

```json
{
  "dependencies": {
    "@makaio/hooks": "workspace:*"
  }
}
```

**Modify messages before they reach the AI:**

```typescript
import { createHook } from '@makaio/hooks';

const { unsubscribe } = createHook('PreUserMessage', {
  name: 'my-enricher',
  priority: 100, // higher runs first
  handler: (ctx) => {
    // Access enriched context
    console.log('Session:', ctx.session?.title);
    console.log('Recent turns:', ctx.recentHistory.length);

    // Inject context for downstream consumers (adapters)
    ctx.setTurnContext('userTimezone', 'America/New_York');

    // Modify the message
    ctx.replacePayload({
      message: { content: `[Enhanced] ${ctx.payload.message.content}` },
    });
  },
});
```

**React to turn completion:**

```typescript
createHook('PostTurn', {
  priority: 0,
  handler: (ctx) => {
    if (ctx.success) {
      console.log(`Turn ${ctx.turnId} completed in session ${ctx.sessionId}`);
    } else {
      console.error(`Turn failed: ${ctx.error}`);
    }

    // Access session data
    const lastTurn = ctx.recentHistory.at(-1);
    console.log('Last turn outcome:', lastTurn?.outcome);
  },
});
```

**Abort message processing:**

```typescript
createHook('PreUserMessage', {
  name: 'content-filter',
  handler: (ctx) => {
    if (containsBlockedContent(ctx.payload.message)) {
      ctx.abort('Blocked content detected');
    }
  },
});
```

**Generic interception (escape hatch):**

```typescript
import { AgentSubjects } from '@makaio/contracts';

createHook('BusMessage', {
  subject: AgentSubjects.tool.use,
  handler: (ctx) => {
    if (ctx.payload.toolName === 'dangerous') {
      ctx.stopPropagation(); // Block the event
    }
  },
});
```

## Architecture Principles

**1. Named over Generic** - Use named hooks (`PreUserMessage`, `PostTurn`) for enriched context; `BusMessage` only as escape hatch

**2. Session Enrichment** - Hooks automatically fetch the session, recent turns, and optional host-contributed context extensions when `sessionId` is available

**3. Priority Ordering** - Higher priority handlers run first (default: 0)

**4. Immutable Routing** - `replacePayload()` only allows modifying `message` and `sessionContext`, not routing fields

**5. Graceful Degradation** - Enrichment failures return empty data, hooks continue to run

## Key Exports

**Factory:**
- `createHook(name, options)` - Register a typed hook

**Types:**
- `HookName` - Union of all hook names
- `HookRegistration` - Returned by `createHook()` with `unsubscribe()`
- `HookContext<K>` - Context type for hook name `K`
- `HookOptions<K>` - Options type for hook name `K`

**Context Types:**
- `PreUserMessageContext` - Session-enriched context with `setTurnContext()`, `abort()`
- `PostUserMessageContext` - Context after message dispatch (agentId, adapterId, sessionId)
- `PostTurnContext` - Turn completion data with `success`, `error`, session, recent turns, and context extensions
- `BusMessageContext<P>` - Raw interceptor context for generic hooks

**Runner (advanced):**
- `runPreUserMessageHooks(input, bus)` - Execute PreUserMessage hooks programmatically
- `registerPreUserMessageHook(name, handler, options, priority)` - Direct registration
- `runPostUserMessageHooks(input, bus)` - Execute PostUserMessage hooks programmatically
- `registerPostUserMessageHook(name, handler, options, priority)` - Direct registration

**Errors:**
- `HookAbortError` - Thrown by `abort()` to cancel message processing

## Design Philosophy

**"Intercept with context"** - Named hooks provide session, recent turn, and optional host context extension data without manual queries. Generic hooks remain available for edge cases.

---

*Part of Makaio Framework*
