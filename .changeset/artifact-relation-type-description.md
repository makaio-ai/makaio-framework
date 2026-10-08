---
"@makaio/framework": minor
"@makaio/contracts": minor
---

Relation types carry descriptions. `RelationTypeRegistrationSchema` gains an optional non-empty `description` stating the meaning of the verb, and `RelationEndpointSchema` gains an optional non-empty `description` stating how the verb is used for that endpoint pair. The per-entry description is part of the entry, so entries that differ only in it stay distinct; the shorthand fields cannot carry it, and an entry without any list is open and does not keep it. `mergeRelationTypeRegistrations` takes the type description from whichever side has it and throws `RelationTypeConflictError` (`field: 'description'`) when two contributions differ. The artifact schema registry keeps both descriptions through normalization and listing.
