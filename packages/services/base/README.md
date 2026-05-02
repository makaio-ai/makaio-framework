# @makaio/service-base

Abstract base class for Makaio bus services. Handles `init`/`destroy`
lifecycle boilerplate — idempotency guards, cleanup tracking, and automatic
handler teardown — so concrete services only implement `onInit()` and
optionally `onDestroy()`.

## Workspace Usage

This package is private to the workspace. Reference it from other workspace packages instead of installing it from npm:

```json
{
  "dependencies": {
    "@makaio/service-base": "workspace:*"
  }
}
```

## Usage

```typescript
import { BaseService } from '@makaio/service-base';
import type { IMakaioBus } from '@makaio/bus-core';
import { MySubjects } from './subjects.js';

class MyService extends BaseService {
  private readonly tracker = {
    stop: async () => undefined,
  };

  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {
    // Registered handlers are auto-unsubscribed on destroy()
    this.registerHandler(MySubjects.doWork, (ctx) => {
      ctx.setResult({ ok: true });
    });

    // Non-handler cleanup (timers, external subscriptions, …)
    const timer = setInterval(() => this.tick(), 5_000);
    this.addCleanup(() => clearInterval(timer));
  }

  protected async onDestroy(): Promise<void> {
    // Only needed for teardown beyond handler unsubscription
    await this.tracker.stop();
  }

  private tick(): void {
    // Example timer callback for background work.
  }
}

// Lifecycle
const svc = new MyService(bus);
await svc.init();    // idempotent — safe to call multiple times
await svc.destroy(); // unsubscribes all handlers, runs cleanups
```

## API overview

| Member | Description |
|--------|-------------|
| `BaseService` (abstract class) | Base with lifecycle guards and cleanup tracking |
| `init()` | Initialize the service; subsequent calls are no-ops |
| `destroy()` | Tear down the service and unsubscribe all handlers; idempotent |
| `initialized` | `true` after `init()` completes and before `destroy()` |
| `registerHandler(subject, handler)` | Subscribe to a bus subject; auto-unsubscribed on destroy |
| `addCleanup(fn)` | Enqueue an arbitrary cleanup function for teardown |
| `onInit()` (abstract) | Implement to register handlers and resources |
| `onDestroy()` (optional) | Implement for teardown beyond automatic handler cleanup |
