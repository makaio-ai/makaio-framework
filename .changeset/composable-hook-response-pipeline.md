---
"@makaio/contracts": minor
"@makaio/core": minor
"@makaio/bus-core": minor
"@makaio/subsystem-client": minor
"@makaio/extension-client-hooks": minor
"@makaio/client-claude-code": minor
"@makaio/client-codex": minor
---

Add composable client hook response pipeline for extension-authored contributions.

- Replace `mode` enum with `responseCapabilities` array on `ClientHookEventDeclaration`, deriving transport mode from capability presence
- Add `hostLocalRequest()` schema wrapper and `HostLocalRequestSubjectSchema` type to prevent response-hook round-trips from crossing transport boundaries
- Expose `RequestContext.deadline` in bus-core and enforce `hostLocalRequest` subscription and dispatch semantics
- Define `ContributorDefinition`, `CanonicalEffect`, `ProviderContractCatalogEntry`, interaction selectors, and failure policies in `@makaio/contracts/client`
- Implement `ClientHookResponseRegistry`, `ClientHookProviderContractRegistry`, concurrent deterministic `collectContributions` collector, and `ClientHookResponseContributionProcessor` in `@makaio/subsystem-client`
- Add deadline-aware timeout budget management to the client-hooks bridge CLI
- Implement Claude Code provider contract (`claude-code.tool-response@1`) with namespaced approve/deny capabilities, canonical context.append, typed effect builders, restrictive precedence, and native `additionalContext` rendered separately from permission reasons
- Implement Codex provider contract (`openai.codex-hook-response@1`) from the pinned `rust-v0.144.1` source: synchronous context, namespaced block, permission-deny, and input-update responses across its five supported hook events; live CLI probes remain pending
