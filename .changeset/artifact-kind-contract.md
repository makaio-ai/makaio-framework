---
"@makaio/contracts": major
"@makaio/framework": major
---

Replace legacy Artifact Kind metadata with a validated contract requiring a semantic category, positive integer schema generation, complete data schema, and readable title path. Migrate Artifact revisions, registry contributions, workflow bindings, and lifecycle-hook inputs to numeric schema generations. Declare relation, uniqueness, evidence, and data-path requirements without introducing their future policy engines.

Remove Kind-owned scope/observation schemas, discriminator/conflict policy, status/lifecycle hints, projection policy, and default context. Implicit context expansion and generic Kind-driven rendering/readiness are retired; explicit context selectors and custom builders remain. Add optional caller-assigned create identity for retry-safe creation using existing storage concurrency checks.

Live Kind authoring preserves dynamic defaults and rejects undeclared fields before refinements. Canonical registrations retain JSON Schema 2020-12. Unsupported closed-object intersections and lossy Zod tuple serialization fail visibly instead of publishing inconsistent contracts. Existing opaque schema generations require an explicit migration strategy; no historical data rewrite is performed.
