---
---

Declare `tsdown` as an explicit devDependency in every workspace whose scripts invoke it. Yarn Berry only exposes binaries of declared dependencies to workspace scripts, so the per-workspace `build: tsdown` scripts failed with exit 127 ("command not found") in the standalone dev-publish closure build. No runtime or published-artifact change.
