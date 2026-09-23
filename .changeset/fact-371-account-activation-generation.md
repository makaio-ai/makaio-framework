---
"@makaio/extension-account-manager": patch
---

Keep account activation transactions bound to their service initialization. A delayed request from a destroyed generation can no longer prepare or finalize an activation after the account manager restarts.
