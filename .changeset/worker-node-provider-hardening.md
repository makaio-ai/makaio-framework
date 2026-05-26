---
"@makaio/framework": patch
"@makaio/contracts": patch
---

Harden WorkerNode provider dispatch by keeping resolved credentials out of lifecycle events, preserving URL and package worker import specifiers, and lazily creating the built-in Piscina pool.
