---
'@makaio/kernel': major
---

Move per-extension data directories from a flat `$MAKAIO_HOME/<name>` layout to
a `$MAKAIO_HOME/data/<encoded>` subtree.

**Problem.** The flat layout placed each extension's writable data directory
immediately under the Makaio home, where it could collide with reserved
top-level names such as `config/`, `keys/`, `extensions/`, or `makaio.db`.
A scoped extension name such as `@acme/tools` could also create a nested
directory structure at the home root.

**New layout.** `ExtensionContext.dataDir` now resolves to
`$MAKAIO_HOME/data/<encoded>`, where `<encoded>` is the percent-encoded path
segment produced by `encodeExtensionNameAsPathSegment`. The `data/` prefix
isolates extension storage from reserved paths; encoding ensures every extension
occupies exactly one directory component regardless of its name, so
`@acme/weather-tools` resolves to `data/%40acme%2Fweather-tools`.

**Breaking changes.**

- **No migration.** Data an extension wrote under the old
  `$MAKAIO_HOME/<name>` layout is not moved. An existing installation loses
  access to it on upgrade. To keep it, move each extension's directory by hand
  from `$MAKAIO_HOME/<name>` to `$MAKAIO_HOME/data/<encoded-name>` (encode the
  name with `encodeExtensionNameAsPathSegment`) before starting the extension
  again, or accept a fresh, empty data directory.

- Extension code that constructs a path relative to `ctx.dataDir` by going
  upward (e.g. `path.join(ctx.dataDir, '..', 'other')`) would now land in
  `$MAKAIO_HOME/data/` instead of `$MAKAIO_HOME/`. No known extensions do this;
  extensions must only write inside their own `dataDir`.

- **Kernel:** An extension whose name cannot be encoded as a filesystem
  path segment (empty, a dot segment, non-well-formed Unicode, or encoded form
  too long for a 255-byte filesystem component) now **fails to start** with a
  descriptive error. Previously it silently received a `dataDir` built from the
  raw name, which violated the codec's injectivity guarantee (two ill-formed
  names could claim the same directory). The check runs eagerly in
  `startExtensionEntry` for every enabled extension — including those with no
  `create` factory, no `storage.registerHandlers`, and no contribution processors
  — so the failure is always isolated per-extension rather than surfacing later
  inside `forEachActiveExtension` or `forExtension`. Only critical extensions
  escalate to a boot abort.

- **Kernel:** There is no longer a load-set case-insensitive data-directory
  collision check. An earlier version of this change detected `Gateway` and
  `gateway` colliding by inspecting the full set of names
  `ExtensionCoordinator.load` admitted, and failed both. That detector has
  been removed: it could only ever see the names loaded together in *this*
  process, and the other half of a colliding pair need not be one of them — an
  extension can be uninstalled and leave `data/Gateway` behind, or be filtered
  onto a different runtime surface, and either way the survivor would start,
  read `findCaseInsensitiveDataDirCollisions`'s empty result, and be handed
  the stale or foreign directory anyway. `@makaio/contracts`'s codec now closes
  the hazard at the one place that always has enough information — encoding a
  single name — by escaping every uppercase byte, so `Gateway` and `gateway`
  encode to `%47ateway` and `gateway` and can never be folded onto each other
  by any case-insensitive filesystem. Two extensions loaded together as
  `Gateway` and `gateway` now both **start successfully**, with distinct data
  directories (`data/%47ateway` and `data/gateway`), and — unlike the removed
  detector — this also protects against the stale-directory and
  filtered-surface cases the detector could never see. See
  `@makaio/contracts`'s `encodeExtensionNameAsPathSegment` TSDoc for the full
  argument that this closes case folding for every name, not only ones loaded
  together.

**The full invariant, and why the remaining checks in this coordinator do not
grow with every newly discovered host quirk.** A hazard that is a property of
one name's own spelling — a trailing dot or trailing space (`gateway` vs.
`gateway.` or `gateway `) — is closed by the codec at encode time: `gateway.`
encodes to `gateway%2E`, a segment that never collides with `gateway`'s to
begin with, so extensions named `gateway` and `gateway.` both **start
successfully** with distinct data directories (`data/gateway` and
`data/gateway%2E`) and no coordinator-level check is needed for it. Case
folding used to be the one hazard that looked like a property of the *set* of
loaded names rather than of one name — `Gateway` and `gateway` are each
perfectly valid on their own, and only comparing them revealed the clash — but
escaping case at encode time turns it into the same shape as the trailing-dot
case: a property of one name's own spelling, closed once, in the codec,
without a coordinator-level detector at all. This coordinator's remaining
eager pre-flight check — unencodable-name rejection — stays a per-name check
for the same reason. See `@makaio/contracts`'s `encodeExtensionNameAsPathSegment`
TSDoc for the complete, one-place enumeration of every host-normalisation
hazard this codec closes.
