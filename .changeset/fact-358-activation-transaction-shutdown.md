---
"@makaio/extension-account-manager": patch
"@makaio/framework": major
---

**@makaio/framework**

- Unregister `BaseService` bus handlers before `onDestroy()` runs, while retaining resource cleanups until after the hook. This changes the lifecycle contract for subclasses that rely on their handlers during `onDestroy()`.
- Expose a protected lifecycle generation and current-lifecycle predicate for subclasses that must fence asynchronous lifecycle work.

**@makaio/extension-account-manager**

- Preserve typed activation transaction responses while the account manager drains during shutdown.
