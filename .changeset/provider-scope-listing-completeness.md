---
"@makaio/contracts": patch
---

Reject complete allocation listings in scope blocks where listing was prohibited.

Scope blocks use a narrower type for reasons that forbid listing, and reaching the observation cap requires unknown completeness.
