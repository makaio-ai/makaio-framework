---
"@makaio/contracts": patch
"@makaio/extension-coderabbit": patch
"@makaio/extension-review": patch
"@makaio/framework": patch
---

Harden workflow block and review extension lifecycle behavior.

- Constrain workflow block change revisions to integer, non-negative values.
- Roll back CodeRabbit capability registrations when initialization fails.
- Preserve verified review findings when a fresh source still reports them as verified.
- Restore workflow block registry state when change event emission fails.
