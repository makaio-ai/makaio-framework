---
title: Bus Decoupling Patterns
---

When a module needs to interact with a module above it in the dependency
hierarchy, it must not import from that module directly. Instead, it uses the
bus to invert the dependency direction while preserving type safety.

The bus is not just a message broker — it is the primary mechanism for keeping
the framework's layered architecture clean. These patterns show how.

## Dependency Grain

Dependencies flow **downward**. Importing with the grain is always allowed.
Importing against it requires one of the inversion patterns below.

```
@makaio/core, bus-core                    ← foundation: types, bus primitives
@makaio/contracts                         ← shared contracts, Zod schemas
@makaio/kernel                            ← extension lifecycle, orchestration contracts
@makaio/services-core                     ← shared service contracts
framework extensions                      ← framework extension packages
apps (CLI, Electron, Electrobun)          ← host shells
─── framework / extension boundary ───
your extension                            ← registers handlers, emits events
your extension's UI                       ← subscribes to bus, renders
─── composition roots ───
electron main.ts, cli-entry.ts            ← wiring, knows everything
```

## Choosing an Inversion Pattern

| Question | Pattern |
|----------|---------|
| Is the contract genuinely generic and useful across layers? | **Contract lifting** — move schemas to the shared lower layer |
| Does the caller need a capability owned by a higher layer? | **Dependency inversion** — define an abstract subject at the caller's level; higher layer registers a handler |
| Is it a fire-and-forget UI side effect? | **UI-intent relay** — emit intent through a discriminated bridge subject; UI dispatches by action ID |
| Is it one-shot wiring known at startup? | **Boot-time injection** — pass a callback via options at the composition root |

These are not mutually exclusive. A single refactoring may combine patterns.
Choose the pattern that preserves the most type safety with the least
abstraction.

## 1. Contract Lifting

Move the schema and namespace definition to a lower shared layer so both sides
can import it without violating the dependency grain.

**When to use:** The contract is infrastructure (filesystem events, dialog
actions, storage operations) rather than domain-specific. Both layers
legitimately need it.

**Example — lifting filesystem subjects to the shared service layer:**

An extension needs to subscribe to filesystem change events. The schemas are
pure Zod with no domain knowledge — they describe generic file operations.
Moving them from a higher-level service package to `@makaio/services-core`
lets extensions import them directly:

```
Before:  your-extension → @makaio/services/filesystem/namespace       against the grain
After:   your-extension → @makaio/services-core/filesystem/namespace  with the grain
```

**Mechanics:**
1. Copy `schemas.ts` (pure Zod) and `namespace.ts` (namespace definition) to the
   lower package
2. Add subpath exports (e.g., `./filesystem/schemas`, `./filesystem/namespace`)
   so consumers can import the definition without registering anything
3. Replace the original files with re-exports from the lower package
4. Update against-grain consumers to import from the lower package

**Invariant:** The lifted schemas must have zero imports from the layer they
left. If a schema references domain-specific types, it cannot be lifted — use
dependency inversion instead.

## 2. Dependency Inversion via Bus

The lower layer defines a generic subject (the question). The higher layer
registers a handler (the answer). The lower layer never learns the higher
layer's vocabulary.

**When to use:** The caller needs a capability that is conceptually owned by a
higher layer. The capability cannot be lifted because it carries domain
knowledge — but the *question* can be made generic.

**Example — capability-based VCS resolution:**

A framework service needs to check VCS status (branch name, uncommitted changes)
but VCS implementations are extension-owned. The framework defines generic
capability subjects. The VCS extension registers a provider at runtime:

```ts
// Extension: registers itself as a VCS capability provider at boot
bus.emit(CapabilitySubjects.register, {
  capabilityId: 'vcs',
  provider: { id: 'github', displayName: 'GitHub' },
});
```

```ts
// Framework: discovers available capability providers
const result = await bus.requestOptional(
  CapabilitySubjects.listProviders,
  { capabilityId: 'vcs' },
);

if (result.handled && result.data.providers.length > 0) {
  // Provider is available — interact through domain-specific bus subjects
  // that the extension also registers (e.g., VCSSubjects.getBranch)
}
```

The framework never imports from the extension. The extension fulfills a
contract the framework defined. If no VCS extension is installed,
`requestOptional` returns `{ handled: false }` and the framework applies a
sensible default.

**Mechanics:**
1. Define a new subject at the caller's layer with a generic vocabulary
2. Higher layer registers a handler (typically at priority 100)
3. Caller uses `requestOptional` — framework-only mode gets `{ handled: false }`
4. Use `extendSubject` when the higher layer needs to widen the request
   schema with additional fields

**Invariant:** The abstract subject's schema must not reference types from the
higher layer. If you find yourself importing extension types into the subject
definition, the abstraction is leaking.

## 3. UI-Intent Relay

The service emits intent through a generic, discriminated bridge subject. The
UI subscribes, pattern-matches on the intent discriminator, and fulfills the
side effect using its own local subjects. The service never imports UI subjects.

**When to use:** A service needs to trigger a UI side effect (open a modal,
navigate to a view, show a confirmation) but must not depend on the UI layer.

**Example — opening a view after background processing completes:**

A background service finishes work and wants to navigate the user to the result.
Instead of importing UI navigation subjects, it emits intent through a bridge:

```ts
// Service: emits intent — does not know how the UI fulfills it
await bus.emit(ActionSubjects.uiAction, {
  actionId: 'result:show' satisfies UiActionId,
  resultId,
});
```

```ts
// UI layer: subscribes and dispatches locally
bus.on(ActionSubjects.uiAction, (ctx) => {
  switch (ctx.payload.actionId) {
    case 'result:show':
      navigationStore.navigate(`/results/${ctx.payload.resultId}`);
      break;
  }
});
```

**Mechanics:**
1. Identify or create a bridge subject with a string discriminator field
   (e.g., `uiAction` with `actionId`)
2. Register known discriminator values in an extensible registry via
   declaration merging
3. Service emits intent; UI handler switches on the discriminator and
   dispatches locally
4. Extensions extend the registry via `declare module` to add their own intents

**Invariant:** The bridge subject's schema uses `z.string()` for the
discriminator at runtime, but TypeScript consumers must use the registry type
for compile-time safety. Use `satisfies` at emit sites.

## 4. Boot-Time Injection

A callback or configuration value is passed through an options interface at
the composition root. The framework code calls the injected function without
knowing what it resolves to. Framework-only mode omits the callback; the
consumer either skips the feature or fails fast with a clear error.

**When to use:** The dependency is one-shot wiring known at startup. The
capability is too specific for an abstract subject but too coupled for a
direct import.

**Example — injecting a signing key resolver for LAN transport auth:**

A transport needs to verify peer signatures for LAN-mode connections. Instead
of importing a specific key management service, it accepts an optional callback:

```ts
// Framework: accepts optional callback
interface TransportOptions {
  peerSigningKeyResolver?: (peerId: string) => Promise<CryptoKey | null>;
}

// Composition root: wires the specific implementation
startTransport({
  peerSigningKeyResolver: (peerId) =>
    bus.request(KeySubjects.getPeerSigningKey, { peerId }),
});
```

Framework-only mode passes nothing. If `--lan-bind` is requested without a
resolver, boot fails fast with a clear error message.

**Mechanics:**
1. Add an optional callback field to the relevant options interface
2. Framework code calls the callback when present; applies a default or
   fails fast when absent
3. The composition root imports the specific implementation and passes it in

**Invariant:** The callback's type signature must use only framework-tier
types. If the signature references extension-specific types, extract a
framework-owned interface first.

## Type Safety Requirement

Decoupling must not sacrifice static checkability:

| Pattern | Type Safety Mechanism |
|---------|----------------------|
| Contract lifting | Zod schemas shared at the lower layer — same compile-time and runtime guarantees |
| Dependency inversion | Abstract subject has its own Zod schema; `requestOptional` returns a typed discriminated union |
| UI-intent relay | Declaration-merged action ID map provides compile-time checking on discriminator values |
| Boot-time injection | Callback signature uses framework-tier types; composition root satisfies the contract |

If a decoupling approach introduces untyped string conventions, `as` casts, or
`z.unknown()` payloads without a typed wrapper, it is incomplete.

### Anti-Pattern: Widening to `string` Is Not Decoupling

When a declaration-merged type map lives in the wrong layer, consumers across
the boundary hit type errors. The temptation is to replace the map-derived
union with plain `string` — "the wire format accepts any string anyway."

This is type erasure, not decoupling. It silently removes the compile-time
allowlist and turns category/action-ID mismatches into runtime bugs.

**Rule of thumb:** If your fix for a cross-boundary type error is to widen a
type, you are hiding the boundary violation instead of fixing it. Move the
declaration-merge target to the correct layer instead.

## When NOT to Invert

Not every cross-layer import is a violation:

- **With-the-grain imports are always fine.** An extension importing from
  `@makaio/services-core` is the intended direction.
- **Re-exports from lower layers are fine.** A higher-level package re-exporting
  shared contracts is correct direction.
- **Composition roots may import anything.** `electron/main.ts` and
  `cli-entry.ts` are wiring code — they exist to bridge layers.
- **Test files have relaxed boundaries.** Tests may import from any layer to
  set up fixtures and assertions.
