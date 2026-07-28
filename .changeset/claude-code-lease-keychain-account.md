---
"@makaio/client-claude-code": patch
---

Publish the Keychain account name from the Claude Code session-config lease.

A lease that materializes native credentials into an isolated session directory
must also return the environment required to read them back. The lease returned
only `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, omitting the
account the credentials were written under.

Makaio resolves that account as `process.env.USER || os.userInfo().username`,
but the `claude` binary resolves it from `USER` alone with no fallback when
reading an isolated credential store. A spawned agent whose environment did not
already carry `USER` therefore failed with `Not logged in · Please run /login`
against a store that demonstrably held valid credentials.

The lease now publishes `USER` as the exact account it wrote under, so the
symmetry holds even when the account falls back to the sanitized default.
