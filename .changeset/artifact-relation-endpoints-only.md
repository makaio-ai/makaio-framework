---
"@makaio/framework": minor
"@makaio/contracts": minor
---

**Breaking:** relation types declare endpoint pairs only through `endpoints`. `RelationTypeRegistrationSchema` drops the flat `sourceKinds`/`targetKinds`/`targetRefClasses` fields and rejects unknown keys, so a registration that still writes pair lists on the type fails validation with `Unrecognized key(s) …: declare endpoint pairs under endpoints` instead of being read as an open type. Move such lists into one `endpoints` entry. A registration without `endpoints` stays open.

`normalizeRelationTypeRegistration` and `mergeRelationTypeRegistrations` return `RelationTypeRegistration`; the type `NormalizedRelationTypeRegistration` is removed, because input and normal form now have the same shape.
