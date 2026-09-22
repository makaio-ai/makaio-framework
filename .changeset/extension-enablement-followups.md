---
"@makaio/framework": patch
---

Harden extension enablement follow-ups: the CLI refuses offline fallbacks for
remote bus targets (including post-probe connection failures), loads the local
enablement store only for local or offline listings, and routes names held by a
same-named framework package through the unmanaged persistence path while
surfacing the shadowed installed override in listings. Tray unregistration
failures join the disable teardown contract, onboarding filters the extension
snapshot before step conditions freeze, and the public subject docs are
regenerated for the persist-only contract.
