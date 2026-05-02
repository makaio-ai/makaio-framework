# GitHub Copilot SDK - Session-Based Limitations

This adapter remains **session-based** due to fundamental constraints in the GitHub Copilot SDK.

## Why Stateless Architecture Cannot Be Applied

### SDK Constraint: Stateful Session Objects

The Copilot SDK provides a `Session` class that:
1. **Maintains conversation state internally** - The Session instance holds accumulated context and state
2. **Auto-stitches history** - Automatically reconstructs message history within the session
3. **Cannot be created fresh per message** - The Session object is long-lived and tied to a specific `sessionId`

```typescript
// session-init.ts
await session.initialize();
const adapterSessionId = await session.getAdapterSessionId();
```

### Architectural Incompatibility

The stateless architecture requires:
- **Fresh SDK session per message** - Each message gets a new SDK session with curated history
- **SDK receives full context** - All prior context passed explicitly to SDK

The Copilot SDK requires:
- **Single persistent session** - One Session object managing ongoing conversation
- **Automatic history reconstruction** - SDK maintains state internally

This is a fundamental mismatch that cannot be resolved without breaking changes to the SDK's API design.

## Current Implementation

This adapter maintains a **single Session instance** per connector:
- Created once during `initializeSession()`
- Reused for all subsequent messages
- Session state manages conversation history internally

Makaio `messageHistory` is already consumed by `session.ts`: it is formatted as
a transcript and prepended to the prompt before the current user message. That
preserves host-provided transcript context, but it does not make the adapter
stateless because the Copilot SDK still requires a persistent `Session` object
for the active SDK conversation.

## Migration Path (If Needed)

If Copilot SDK releases a stateless API in the future:
1. New SDK would need message-level context parameters instead of Session objects
2. Remove `Session` member variable
3. Implement fresh session creation per `processUserMessages()` call
4. Replace the current transcript injection with the SDK's structured history/context input

For now, the remaining limitation is the SDK session model itself.
