---
"@makaio/contracts": patch
"@makaio/extension-shell": patch
"@makaio/framework": patch
---

**@makaio/contracts**
- Adds `createBusNamespace`, subject helpers, `MakaioBusLike`, storage namespace definitions, and updates bus/storage registration APIs to accept definition objects and bulk namespace registration.

**@makaio/extension-shell**
- Registers declared namespaces explicitly in renderer, runtime, and handler boot paths, adds namespace catalogs, updates host namespace lists, removes legacy `register` subpath exports, and switches import sites to new public entry points such as `subjects` and direct package barrels.

**@makaio/framework**
- Converts contract namespaces to pure definitions, introduces `MakaioNodeExtension` and kernel-specific extension aliases, broadens bus-facing generic types, and retypes many exported package manifests and package factory return types.
- Registers declared namespaces explicitly in renderer, runtime, and handler boot paths, adds namespace catalogs, updates host namespace lists, removes legacy `register` subpath exports, and switches import sites to new public entry points such as `subjects` and direct package barrels.
- Rewrites tests and fixtures to register namespace definitions explicitly, adds unregistered-namespace warning coverage, extends bus mocks with `registerNamespaces`, updates lifecycle ordering assertions, and revises documentation and release notes to describe definition-based registration.
