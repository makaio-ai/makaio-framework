---
"@makaio/framework": patch
---

Schedule the no-argument full-suite test run through a shared orchestrator instead of a
per-workspace batch loop. Memory-capable hosts run every Vitest project in one child with an
explicit heap ceiling and an oversubscribed worker budget; memory-constrained hosts keep bounded
batches. Where machine locking applies — local runs that have not opted out — every batch takes a
machine-wide lock so concurrent runs from other checkouts interleave rather than oversubscribing the
host. CI runs and `MAKAIO_TEST_NO_MACHINE_LOCK` skip the lock entirely.

The git test lane no longer forces a single worker and instead pins a neutral git environment,
disabling global/system config, fsync, and detached auto-maintenance so per-test repositories behave
identically on every machine.

Validation file discovery, lint, and format surfaces now hard-ignore nested agent-session worktrees
regardless of `.gitignore` state.
