---
"@makaio/contracts": minor
"@makaio/kernel": minor
"@makaio/runtime-node": minor
"@makaio/services-package-manager": minor
---

Add headless extension enable/disable via a runtime-managed enablement file.

`ExtensionConfigProvider` gains an optional `persistEnabled?(name, enabled): Promise<void>` — the write half of the enablement contract. Existing implementations that omit it continue to work; the coordinator treats the method as optional.

**Breaking (P2-3):** `BootMakaioRuntimeCoreOptions.extensionConfigProvider` is narrowed from
`ExtensionConfigProvider` to `Pick<ExtensionConfigProvider, 'loadConfig'>`. The `loadEnabled` method
is no longer consumed from this provider; enablement is now managed exclusively by the
runtime's `ExtensionEnablementStore`. Hosts that forwarded `loadEnabled` through this seam must
remove it — the method is simply ignored if left in place by a duck-typed caller, but TypeScript will
reject the wider type until updated.

`@makaio/runtime-node` ships a new `ExtensionEnablementStore` backed by `$MAKAIO_HOME/config/extensions.json`. The file stores only disabled extension names (`{ "disabled": ["name1", ...] }`), keeping it self-cleaning and hand-editable. A missing or corrupt file defaults to all-extensions-enabled with a console warning so boot never bricks.

`bootMakaioRuntimeCore` now:

- Loads the enablement store unconditionally from `$MAKAIO_HOME/config/extensions.json` (step 0, alongside the operator config snapshot).
- Passes `loadEnabled` and `persistEnabled` from the store to `ExtensionCoordinator`. `kernel:extension.setEnabled` durably records the preference in this file, but never applies it to the running process — see the `@makaio/kernel` entry below for why.
- Removes the hard pre-load exclusion (`filterPersistentlyEnabledExtensionPackages`) so disabled extensions receive a coordinator entry and start in `skipped` state, observable and toggleable for the next process restart.
- Continues to filter disabled packages from automation cron scheduler host policy selection so a disabled extension's scheduler cannot run without its owner.

`persistEnabled` uses read-modify-write, backed by two guarantees: an in-process write queue that
serializes one store instance's own `persistEnabled` calls so two of them can never interleave their
read and write halves, and a cross-process file lock (via `proper-lockfile`, already a Makaio
dependency for this same kind of coordination) that serializes the read-modify-write cycle itself
across every process holding a store instance for the same file. Any number of processes — two
concurrent offline CLI invocations, or a CLI writing a name a running server does not manage while
that server's own `persistEnabled` writes a different name — can call `persistEnabled` at the same
time without one write silently discarding another.

The `disabled` field written to the file also empties itself: an emptied disabled set now writes
`{}` instead of `{"disabled":[]}`, matching the "self-cleaning" file described above (both parse
back identically on read).

The kernel (`@makaio/kernel`) gains several improvements:

- **Critical override moved to `load()`:** the coordinator sets `entry.enabled = true` and emits the warning during load, so critical extensions always have their static surfaces (windows, tray, CLI) collected — even when hand-disabled in the enablement file.
- **Conditional surface collection:** `load()` collects windows, tray entries, and CLI contributions only for enabled extensions. An extension disabled at boot only ever collects its surfaces again through a fresh process restart's own `load()` call.
- **Breaking: `kernel:extension.setEnabled` is persist-only.** Live extension toggling is not a
  contract this runtime can honor: package contributions such as client definitions, the
  `runtimeOwnership` single-owner selection, `runtimeBoot.configure()`, `storage.migrations`, and
  host-level policies wired in at boot are composed exactly once before `startAll()` and have no
  seam to replay for one package in isolation afterwards. `setEnabled` now durably persists the
  requested preference unconditionally, before comparing it against the process's current runtime
  state to report `outcome`: `'applied'` when they already match, `'restart-required'` when they
  diverge, `'rejected'` when the name is not one the coordinator knows (nothing is persisted).
  Disabling a `critical` extension is refused before writing anything too, but as a thrown error,
  not this `outcome` — the coordinator always force-starts a critical extension on the next boot
  regardless of the file, so persisting the disable would only produce a permanent warning. The
  response shape
  `{ success: boolean; outcome: TransitionOutcome }` is unchanged, but `TransitionOutcomeSchema`
  drops the `'applied-unclean'` variant — it existed only to report a live teardown's partial
  failure, which persist-only `setEnabled` never attempts.
- **New: `ExtensionCoordinator.applyExtensionTransition(name, enabled)`** is the coordinator-internal
  restart primitive that actually runs the enable/disable state machine — for a coordinator's or a
  product package's own mechanics (for example restarting a dependent when its dependency registry
  restarts), never for an operator-originated request. It refuses to activate an extension this
  process never started (`'skipped'` with no surfaces collected), since that entry's boot-only
  contributions were never composed in the first place.
- **Removed: `hasBootOnlyContribution`** (`@makaio/contracts`) and its `BootOnlyContributionPackageView`
  input type. The predicate existed only to decide whether a live hot-enable could safely activate
  a boot-skipped extension; with hot-enable removed, every boot-skipped extension defers to a
  restart uniformly, so the per-contribution distinction is gone.

`critical` moves from the executable `MakaioExtension` type to the pure-data `ExtensionManifest`
(and `ExtensionManifestSchema`), so `descriptor.json` can declare it and every surface can read it
before extension code is loaded. `MakaioExtension` inherits the field unchanged, so executable
packages that already set `critical: true` are unaffected. `descriptorToBasePackage` propagates it
to synthesized packages, and both installer listings (`LocalExtensionEntry`, `PackageInfo`) now
carry it. An extension whose executable package sets the flag should declare it in its descriptor
too, otherwise pre-load surfaces treat it as optional.

`ExtensionInfoSchema` gains a required `critical: boolean`, mirroring `ServiceInfoSchema`. Every
consumer of `kernel:extension.list` / `kernel:extension.get` now receives it, which is what lets a
client refuse a disable the runtime would refuse anyway.

**Breaking:** the `pkg` argument of `isExtensionEnabled` is now required. The critical override is
part of the answer, and an optional argument let call sites drop it silently. Callers that only want
the raw persisted preference use the new `isExtensionDisabledInStore(store, name)`.

`setEnabled` never rolls its persisted preference back except when it refuses the request outright
(unknown name, or a disable of a `critical` extension) — every other request persists
unconditionally, including one whose `outcome` reports `'restart-required'` because the process's
runtime state has not caught up with it yet.

New exports from `@makaio/runtime-node`: `isExtensionEnabled`, `isExtensionDisabledInStore`, `loadExtensionEnablementStore`, `resolveExtensionEnablementFile`, `MAX_ENABLEMENT_FILE_BYTES`, and the types `ExtensionEnablementStore`, `ExtensionEnablementFileData`, `ExtensionEnablementReadFailure`, `ExtensionEnablementReadFailureReason` (expanded with `'unreadable'`), `ExtensionCriticalView`.
