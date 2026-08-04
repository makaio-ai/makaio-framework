---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": minor
---

Add generic extension-contributed Reactions so any extension can declare invocable Reactions without product-domain types.

- New `@makaio/contracts` reaction domain: `defineReaction`, `ReactionDefinition`, `ReactionDescriptor`/`ReactionOutcome` schemas, `ReactionExecutionContext` with per-invocation cancellation and opaque host `ruleRef`, and the `MakaioExtension.reactions` contribution surface
- New `ReactionRegistry` service (owner-namespaced registration, atomic batches, normalized invocation outcomes) with in-process host dispatch
- New `createReactionContributionProcessor` registering/deregistering contributed Reactions through the extension lifecycle, wired into the framework package set and node boot
- Breaking for pre-release consumers: artifact lifecycle hook types renamed `ArtifactReactionHook*` → `AfterArtifactHook*` (e.g. `AfterArtifactHookContext`, `AfterArtifactHookRegistration`)
- Breaking for pre-release consumers: `zodSchemaToJsonRecord` relocated from `@makaio/contracts/workflow` to `@makaio/contracts/shared`; the root `@makaio/contracts` export remains available.
