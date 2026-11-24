---
"@makaio/bus-core": minor
"@makaio/framework": minor
"@makaio/runtime-node": minor
---

Allow kernel callers to give a carrier bus a subscription lifetime. Releasing the carrier now removes direct, scoped, filtered, and channel registrations.
Late registrations are ignored before reaching peers and log one diagnostic per carrier. Promise-based one-shot subscriptions still reject with `OnceAbortError`.
Reactivating an extension opens a fresh subscription lifetime and leaves older carrier buses closed.

The coordinator releases manifest claims when loading extensions fails. Startup diagnostics include the reason an inactive required dependency failed, for example `Required dependencies not active: dep (reason)`.
The coordinator excludes extensions with namespace conflicts and their required dependents from activation, window, tray and CLI surfaces, namespace claims, boot callbacks after load, migrations, HTTP surfaces, and provider-definition discovery. Carrier subscriptions close during teardown even when namespace routing must remain until transport disconnect.

Operator configuration warnings accept startup status alongside schema information. Failed or skipped extensions include their startup diagnosis. Unapplied configuration is reported even if a critical extension aborts startup.
This includes configuration for discovered extensions that startup did not reach.
The report also runs if preparation fails before extension startup begins. When boot aborts before coordinator creation, the diagnostic identifies the boot abort as the reason configuration was unapplied.
