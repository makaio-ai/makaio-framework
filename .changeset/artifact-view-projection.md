---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add the provider-neutral Artifact View contract (eight-section `ArtifactViewModel` with exact artifact identity, structured navigation, and downstream-decorated surface links; projection policy with projected-field view roles and exact affordances; declaration-mergeable `ArtifactViewParamsMap`), the `materialization.artifact.view.resolve` bus RPC with its three-shape response, and the extension builder seam (`artifactViewBuilders` contribution backed by an owner-scoped, collision-safe builder registry and a deterministic generic view builder). Generic views emit visible semantic summary content as their first replaceable section and derive related navigation from direct relations without extra reads; builders can replace or compose navigation through the same deterministic contract as sections. Note: materialization service symbols (view service, builder registry, surface binding registry, and their packages/tokens) are now exported from the dedicated `materialization` services subpath instead of the services root barrel.
