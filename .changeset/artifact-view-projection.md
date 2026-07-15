---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add the provider-neutral Artifact View contract (eight-section `ArtifactViewModel`, projection policy with projected-field view roles and exact affordances, declaration-mergeable `ArtifactViewParamsMap`), the `materialization.artifact.view.resolve` bus RPC with its three-shape response, and the extension builder seam (`artifactViewBuilders` contribution backed by an owner-scoped, collision-safe builder registry and a deterministic generic view builder). Note: materialization service symbols (view service, builder registry, surface binding registry, and their packages/tokens) are now exported from the dedicated `materialization` services subpath instead of the services root barrel.
