---
"@makaio/storage-pg": patch
---

Make the storage-pg workspace manifest publishable as-is: `@makaio/storage-drizzle` moves to devDependencies (its code is import-rewritten to `@makaio/framework/storage/drizzle` at build time) and the runtime framework coupling is declared as a `@makaio/framework` peer dependency, matching the provider/adapter convention. A manifest with `@makaio/storage-drizzle` in dependencies fails every consumer install, because that package is never published. The dev publish lane — which packs workspace manifests without portable staging — now gates on this rule and fails the prepare step with a readable issue list instead of publishing a broken manifest.
