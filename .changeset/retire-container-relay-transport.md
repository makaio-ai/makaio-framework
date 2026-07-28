---
'@makaio/services-core': major
'@makaio/subsystem-workflow-engine': major
---

Retire the container relay authorization branch and the relay coordinates on the
`container-isolated` execution-target contract.

Breaking changes:

- `@makaio/subsystem-workflow-engine`: `isExecutionBoundAccessAllowed` no longer
  admits an authenticated encrypted `e2e` peer whose transport identity equals
  the requested execution id. A remote caller must now present an authenticated
  `workflow-execution-attempt` peer whose Authority-issued `executionId` claim
  matches; local callers are unchanged. The `e2e` disjunct predated the
  allowed-subjects fence, so an `e2e` peer id resolved to unrestricted bus
  subject access — strictly weaker than the attempt identity beside it. Every
  execution-bound seam now shares one `resolveExecutionAttemptPeer` derivation,
  which additionally requires the attempt id and execution claim to be non-empty
  strings.
- `@makaio/services-core`: `ContainerBootstrapConfig` drops `relayPeer` and
  `relayIdentity`. `ContainerBootstrapConfigSchema` is strict, so a bootstrap
  payload still carrying either key now fails validation instead of being
  ignored. Hosts must stop emitting them.
- `@makaio/services-core`: the `container-isolated` spawn descriptor
  (`ContainerIsolatedSpawnRequestSchema`) and execution-target variant
  (`ContainerIsolatedExecutionTargetSchema`) drop `busMode` and `relayUrl`.
  `busMode` was a two-value enum with one reachable value; absence of the field
  is now the only mode, and isolated containers always reach the host bus over
  the Docker host gateway. `busMode` was previously required on the descriptor,
  so callers must remove it. `CredentialFreeRelayUrlSchema`, whose only
  consumers were these two fields, is no longer exported.

Persisted `container-isolated` execution targets keep their type-specific
fields in a JSON config blob, so no storage migration is required: stale
`busMode` / `relayUrl` entries are simply no longer read.

The browser and mobile relay transports are unaffected — this change concerns
only the container-side relay branch, which no host ever provisioned an identity
for and which therefore could never complete its handshake.
