---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add explicit entity targets to artifact relations and reverse queries. Entity references identify independently managed objects by type and ID without claiming an artifact revision. Artifact references retain their required revision pins. Context resolution preserves entity references without treating their entity type as an artifact kind or resolving them through the artifact store.
