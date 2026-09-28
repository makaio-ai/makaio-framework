---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add an optional `when: { path, equals }` condition to artifact kind relation requirements (`registration.relations[]`) (FACT-261). `when.path` is a dot-separated data path that must select a declared field, and `when.equals` is a scalar compared by exact equality; the requirement is skipped when the value is missing, non-scalar, or unequal. Add the pure helper `evaluateRelationRequirements` so hosts can enforce `registration.relations[]` on writes: it counts distinct artifact targets per requirement, filtered by relation type and `targetKinds`, and reports `below-min-items` / `above-max-items` issues.
