---
'@makaio/contracts': minor
'@makaio/framework': minor
---

Add the shared Artifact lifecycle administration contract, separate from
immutable content revisions.

`@makaio/contracts` now exports category-specific lifecycle states and
transitions (`initialArtifactLifecycle`, `advanceArtifactLifecycle`), actor-free
transition intents with trusted host commands, structured situation and
rejection contracts (`ArtifactLifecycleError`), lifecycle history entries, and
additive `artifact.lifecycle.*` RPC and domain event schemas. Records remain
lifecycle-free. Committed events carry only the persisted history entry;
rejected events retain the attempted intent and structured error.

Persistence, repository scoping, host actor resolution, and reaction behavior
remain host responsibilities.
