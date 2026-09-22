---
"@makaio/cli": minor
"@makaio/ui-hooks": minor
---

Add `extension enable`, `extension disable`, and updated `extension list` subcommands to the CLI.

`makaio extension enable <name>` and `makaio extension disable <name>` follow a single-writer rule
for `$MAKAIO_HOME/config/extensions.json`: when no server is reachable the CLI writes the
preference directly, and when a server is reachable and manages the named extension, the CLI writes
nothing and instead calls `kernel:extension.setEnabled`, whose own `persistEnabled` callback (wired
to the same file at boot) is the sole writer for that name. `kernel:extension.setEnabled` is
persist-only: it durably records the preference but never applies it to the running process, since
several package contributions are composed exactly once at boot and cannot be replayed for one
package in isolation. The RPC response carries `{ success, outcome }`; `outcome` is one of
`TransitionOutcome`'s three variants (`'applied'`, `'rejected'`, `'restart-required'`) — `'applied'`
means the process's current runtime state already matches the request, `'restart-required'` means
it was persisted but only a process restart applies it. A disable that targets a critical extension
is refused before anything is written — the runtime starts critical extensions regardless of the
file, so persisting the entry would only produce a warning on every boot. Criticality is resolved
from the running server when one is reachable and from the installed `descriptor.json` otherwise. A
name that is installed but was never loaded into the reachable server's coordinator (interactive-only
on a headless server, unmet `requires`, or `MAKAIO_SKIP_EXTENSIONS`) is the one case the server
cannot persist for — `kernel:extension.get` reports it as `null` — so the CLI writes the enablement
file directly for that name instead, after confirming it against the installed-package listing. A
live request that throws (rather than resolving with `success: false`) is reported as a failure
without touching the file locally, since the CLI never wrote a value of its own to revert in the
live path.

`makaio extension list` now formats live entries as `DisplayName (package-name) [state]` and the
offline state label for skipped extensions is simply `skipped` (the removed `surface-mismatch` label
was never reachable since surface-filtered extensions are absent from the coordinator list).

The offline listing now also expands each installed descriptor into the executable child packages
its server entrypoint exports (for example a dot-prefixed sub-extension), by dynamically importing
the entrypoint and normalizing its default export the same way the runtime does at boot, without
invoking any package's `create()`. `makaio extension enable`/`disable` accept these same
child-package names offline, matching the identities the live listing already addressed.

Re-point onboarding extension enablement writes to the kernel RPC.

`persistPluginEnabled` in `@makaio/ui-hooks/onboarding/plugin-persistence` now fires
`kernel:extension.setEnabled` (which writes to the enablement file via
the coordinator's `persistEnabled` callback) instead of the product config storage RPC.

**Breaking:** `PersistPluginEnabledResult` changes shape from `{ id: string }` to
`{ success: boolean; outcome: TransitionOutcome }` to match the kernel RPC response. Callers that
ignored the result (fire-and-forget) are unaffected. Callers that read the `id` field need to
update, and any new caller that branches on the result should read `outcome`, not just `success`,
for the same reason the CLI does above.

**Breaking:** `PersistedExtensionConfigEntry` is removed, along with its re-exports from
`@makaio/ui-hooks` and `@makaio/ui-hooks/onboarding`. It described a row of the product
config storage that onboarding no longer reads or writes: enablement now lives in the
enablement file behind `kernel:extension.setEnabled`. Callers that named
the type were reading a storage shape that is no longer part of this path.
