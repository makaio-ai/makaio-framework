---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/services-core": major
---

Connection exchange preparation receives the anonymous call context. A prepared exchange now returns the final acceptance or refusal from its transaction callback. This is a breaking type change for exchanges that returned a preselected payload with a void commit callback.

Ordered worker hosts can expose redemption storage through the existing run owner lock. The transaction binds the proven allocation, consumes the booked token and stores the run identity and opaque reply. A replay with the original credentials returns the durable reply while the identity remains live. The transport integration is a separate change.

Orders with atomic redemption refuse separate binding during preparation and commit with `AllocationBindingRequiresRedemptionError`. Supervision records allocation observations independently. Only the redemption transaction assigns the allocation and returns a deeply frozen acceptance.

Atomic redemption can use a durable reference returned by the managed provision call when it is the sole candidate and the provider independently proves it is live and unique. A candidate known only from observation still needs complete listing evidence. The separate binding callback preserves the caller's transaction after a refusal before writing.

Atomic redemption owners must implement the lock-free credential lookup before the authoritative locked check. This is a breaking type change for order sources whose locked snapshots can include redemption fields without supplying the lookup. Owners using separate binding can continue without it. An already stopped host refuses the commit before storage access and leaves the caller's transaction usable. The host bounds proof work by the booked bootstrap or stored identity expiry and passes its cancellation signal to the platform verifier. The root contracts entry exports `ConnectionExchangeCommit`.

Managed shutdown records termination of the exact allocation it stopped. Supervision retains late references for teardown by reference, and provider evidence determines when discovery is complete.
