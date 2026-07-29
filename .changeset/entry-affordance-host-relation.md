---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add optional `hostRelation` field to the entry affordance declaration schema. Host-scoped collection containers in downstream factories use this field to traverse from an entry member back to the host artifact that owns the collection. The field is declaration policy only — request schemas and the affordance matcher are unaffected.
