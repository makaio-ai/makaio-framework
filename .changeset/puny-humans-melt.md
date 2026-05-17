---
"@makaio/client-claude-code": patch
"@makaio/client-codex": patch
"@makaio/contracts": patch
"@makaio/framework": patch
---

**@makaio/client-claude-code**
- Descriptor pins 2.1.143 and managed; definition uses signed-binary-bucket; add config.prime handler and session priming; tests validate settings and pins.

**@makaio/client-codex**
- Descriptor pins 0.130.0 and managed npm; add config.prime and session setup; session service resolves managed config; settings paths updated; tests added.

**@makaio/contracts**
- Schemas restrict strategies to npm/signed-binary-bucket, add VersionCommand and config.prime, change list to pinnedVersion/updateAvailable, and extend manifest binary fields.
- Tests updated for pinnedVersion list shape, strategy union, VersionCommand validation, and config.prime requests/responses.

**@makaio/framework**
- Remove latest-resolution; NpmStrategy enforces pin-only; add SignedBinaryBucketStrategy; update Strategy types and factory.
- Factory, npm pin-only, and signed-binary-bucket verification/edge cases covered.
- Resolver becomes synchronous pin-only; manager/list/update refactored to pins and config.prime; job-runner executeStrategy; add ClientConfigPrimeService/helper; update barrels/package.
- Rewrite to pin-only semantics, events, concurrency, activation/uninstall, and config.prime phases; DDL expectations updated.
- Drop feed-cache columns/subject; persist only activeVersion/updatedAt; migrations and tests updated.
- Exec adds env merge/timeout/error details; StrategyDependencies.exec supports env; tests validate env passthrough.
- Descriptor pins 2.1.143 and managed; definition uses signed-binary-bucket; add config.prime handler and session priming; tests validate settings and pins.
- Docs updated for pinned installs, config priming, publishing gates/smoke, trains certification, seams, and backlog cleanup.
- Adds smoke script and npm script to verify pinned Codex install and Claude manifest/signature.
