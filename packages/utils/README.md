# @makaio/utils

Utility primitives for Makaio Framework. Zero internal dependencies.

## What This Is

Foundation utilities shared across all Makaio packages. Provides:

- `DeferredPromise` - Promise wrapper with tracked rejection handling
- `getErrorString` - Normalizes error types to strings
- `extractJson` - Extracts a JSON object/array substring from text
- `normalizeBusSecret` - Normalizes optional bus secret inputs
- `isBunRuntime` - Runtime feature check used by framework seams
- Timeout system - Layered configuration with provenance tracking

## Quick Start

This is a private workspace package. Add it to a consuming workspace package with the workspace
protocol:

```json
{
  "dependencies": {
    "@makaio/utils": "workspace:*"
  }
}
```

**Deferred Promise:**

```typescript
import { DeferredPromise } from '@makaio/utils';

const deferred = new DeferredPromise<string>();

// Somewhere else...
doAsyncWork().then(() => deferred.resolve('done'));

// Consumer
const result = await deferred.getPromise();
```

**Error String Extraction:**

```typescript
import { getErrorString } from '@makaio/utils';

try {
  await riskyOperation();
} catch (error) {
  const message = getErrorString(error); // Always a string
  console.error(message);
}
```

**Timeout Resolution:**

```typescript
import { resolveTimeouts, explainTimeout } from '@makaio/utils';

const timeouts = resolveTimeouts([
  { layer: 'adapter', source: 'openai-node', config: { completion: 120_000 } },
  { layer: 'runtime', source: 'config.ts', config: { toolApproval: 10_000 } },
]);

console.log(timeouts.values.completion); // 120000
console.log(explainTimeout(timeouts, 'completion'));
// "completion=120000ms (from adapter: openai-node)"
```

## Architecture Principles

**1. Zero Dependencies** - No internal Makaio package imports
**2. Explicit State** - Pure helpers stay stateless; stateful primitives expose clear handles or cleanup paths
**3. Type-Safe** - Full TypeScript with strict types
**4. Traceable** - Timeout system tracks provenance for debugging

## Key Exports

**Classes:**
- `DeferredPromise<T>` - Promise with external resolve/reject control

**Functions:**
- `getErrorString(error)` - Normalize `string | Error | undefined` to string
- `extractJson(text)` - Extract JSON substring from a string (strips surrounding text)
- `normalizeBusSecret(secret)` - Normalize secret values for bus/auth consumers
- `isBunRuntime()` - Detect Bun runtime without importing Bun-only modules
- `createTimeoutSignal(timeoutMs)` - Create an abort signal tied to a timeout
- `resolveTimeouts(layers)` - Merge timeout configs with provenance
- `explainTimeout(tracked, category)` - Debug single timeout source
- `explainAllTimeouts(tracked)` - Debug all timeout sources

**Types:**
- `TimeoutCategory` - `'initialization' | 'acknowledgement' | 'completion' | 'toolApproval' | 'eventWait'`
- `TimeoutLayer` - `'global' | 'adapter' | 'runtime' | 'call'`
- `TimeoutConfig` - Partial config for overrides
- `RequiredTimeoutConfig` - Complete config (all categories required)
- `TrackedTimeoutConfig` - Resolved values with source tracking

**Constants:**
- `DEFAULT_TIMEOUTS` - Global default values per category
- `TIMEOUT_CATEGORIES` - Array for iteration

## Subpath Exports

- `@makaio/utils/health-probe` — health probe helpers
- `@makaio/utils/package-root` — package root resolution
- `@makaio/utils/workspace-root` — workspace root resolution

## Design Philosophy

**"Tracked, not magic"** - Every resolved value knows where it came from. Debug by asking "why?" not by guessing.

---

*Part of Makaio Framework*
