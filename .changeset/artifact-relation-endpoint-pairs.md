---
"@makaio/framework": minor
"@makaio/contracts": minor
---

Relation types declare endpoint pairs. `RelationTypeRegistrationSchema` gains `endpoints: [{ sourceKinds?, targetKinds?, targetRefClasses? }]`; the flat `sourceKinds`/`targetKinds`/`targetRefClasses` fields stay as a shorthand for exactly one endpoint and cannot be combined with `endpoints`. A pair is permitted when one entry permits it, so contributions from several kind modules union the entry list instead of the kind sets. A present list is an allowlist (an empty list permits nothing); an omitted list is open. A `symmetric` type whose `implication` is absent or equals its own `type` permits either orientation of an entry when the target is an artifact with a kind.

`@makaio/contracts` exports the pure helpers `relationTypePermits`, `normalizeRelationTypeRegistration`, `mergeRelationTypeRegistrations`, `RelationTypeConflictError`, the type `NormalizedRelationTypeRegistration`, and `RelationEndpointSchema`/`RelationEndpoint`, so store validation and catalog projection share one pair check and one merge.

The artifact schema registry stores relation types in normal form and merges further contributions to the same `type` instead of keeping the first registration; `artifact.relation-type.list` returns the normal form. Conflicts on `symmetry`, or two differing `implication`s, still reject the registration.
