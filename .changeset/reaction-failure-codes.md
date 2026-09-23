---
"@makaio/contracts": major
"@makaio/services-core": major
"@makaio/framework": major
---

Add stable failure codes to unsuccessful Reaction outcomes so delivery consumers can distinguish unknown Reactions, invalid parameters, cancellation, and handler failures without parsing diagnostic messages. The `error.code` field is required on failed outcomes.
