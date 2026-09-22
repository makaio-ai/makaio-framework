---
"@makaio/cli": major
"@makaio/framework": major
"@makaio/kernel": major
"@makaio/runtime-bun": major
"@makaio/runtime-node": major
"@makaio/services-package-manager": major
---

Make extension name collisions explicit instead of resolving them by registration order.

An extension's `descriptor.name` is its runtime identity: enablement preferences,
dependency resolution, bus and storage namespaces, and the coordinator's entry map are
all keyed on it. Two packages claiming one name were previously resolved by whichever
happened to be registered last, so an operator-disabled extension could displace an
enabled one of the same name and then never start — taking the working extension out of
the boot with nothing but an informational log line.

Identity is now resolved by provenance, and enablement plays no part in it. The tier
winner is fixed by where a package was found; its own enablement only decides whether it
starts.

- **Same tier.** Two descriptors declaring one name inside a single discovery tier have
  no precedence to appeal to, so discovery throws the exported
  `ExtensionNameCollisionError` naming both package paths, and boot re-throws it instead
  of degrading to an extension-less runtime the way it does for recoverable discovery
  failures. Installing an npm package whose descriptor name is already claimed by a
  *different* npm package in the installer's own tier is now refused and rolled back, so
  the ordinary path reports the conflict while it is still fixable. The guard covers the
  tiers the installer manages; a hand-placed package is caught by the boot error. `makaio extension
  update` resolves through that same guarded transaction instead of calling the installer directly,
  so a new version that renames its descriptor onto an already-claimed identity is refused and rolled
  back. The refusal is fatal even for an *optional* dependency: the package is already on disk, so
  skipping it would report success and leave the duplicate identity behind.
- **Across tiers.** The declared precedence still decides (local > installed >
  global-npm), but the shadowed copy is no longer dropped in silence: discovery warns
  with both provenances, and `makaio extension list` reports the losing copy as
  `shadowed by <tier>` instead of omitting it. Precedence settles *descriptor* names only. A name
  claimed across tiers by an executable child package (`foo.bar` exported by descriptor `foo`)
  passes discovery on both sides and is refused at the coordinator, so `extension list` reports both
  claimants as a collision, exits non-zero, and refuses to toggle that name — as it does for two
  copies inside one tier. That contest is judged per surface, mirroring the coordinator, which
  filters by `surface` before it resolves names: two copies restricted to different surfaces are
  never offered to that resolution together and are not reported as colliding. A toggle against a
  *running* server is checked against the installed set too, so a second copy installed after the
  server started is refused rather than persisted for a name the next start will abort on.
- **At the coordinator.** `ExtensionCoordinator.load()` refuses two registrations under
  one name. The one collision it still accepts is an extension registering under a
  framework package name — the supported core override — and only when the host declares
  those names through the new `ExtensionCoordinatorOptions.frameworkPackageNames`. A host
  that mixes framework packages into `load()` without supplying that set now sees a
  legitimate core override reported as a collision.

Dependency resolution judges a batch against the graph it resolves to, not against the
transient state between installs: updating a dependent together with its dependency now
succeeds in either submission order, and an upgrade that renames its descriptor is refused
when an installed package still requires the released name (rather than passing a
version-only check and stranding that dependent at the next boot). `makaio extension update`
re-pins every changed package the project manifest already declares, transitive dependencies
included, so a transitively upgraded pin is not left behind for the next reconciliation to
downgrade.

Breaking: boot aborts on collisions that previously resolved silently, an npm install can
now be refused on an extension-name conflict, and `ExtensionCoordinator.load()` throws
where it used to let the last registration win — including the case a browser-only or
CLI-only descriptor sharing a name with another descriptor's exported child package, which
used to replace it silently during composition. `mergePackagesByDescriptorSourcePriority`
and `DescriptorSourcePackageGroup` are removed — they described a first-source-wins merge
that no boot path used.
