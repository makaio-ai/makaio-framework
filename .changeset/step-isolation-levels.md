---
"@makaio/framework": minor
"@makaio/contracts": minor
---

The contracts export the scale of step isolation levels.

`ISOLATION_LEVELS` orders the levels from the weakest to the strongest: `process`, `user`, `machine`.
`IsolationLevel` with `IsolationLevelSchema` is one level, and `holdsAtLeast(declared, required)` tells whether a
declared level meets a required one. The scale can grow by a level at its place in the order, so compare with
`holdsAtLeast` and do not branch over a fixed set of levels. A value outside the scale meets no requirement.
