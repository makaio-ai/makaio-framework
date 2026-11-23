---
"@makaio/adapter-anthropic-sdk": major
"@makaio/adapter-claude-agent-sdk": major
"@makaio/adapter-claude-code-cli": major
"@makaio/adapter-claude-code-tmux": major
"@makaio/adapter-codex-app-server": major
"@makaio/adapter-cursor-sdk": minor
"@makaio/adapter-openai-node": major
"@makaio/adapter-pi-sdk": major
"@makaio/adapter-qwen-acp": major
"@makaio/agent-sdk": major
"@makaio/ai-adapters-claude-shared": major
"@makaio/ai-adapters-core": major
"@makaio/ai-adapters-stream-session": major
"@makaio/bus-core": major
"@makaio/bus-server": major
"@makaio/bus-transport-message-channel": minor
"@makaio/bus-transport-websocket": major
"@makaio/client-claude-code": major
"@makaio/client-codex": major
"@makaio/contracts": major
"@makaio/core": major
"@makaio/extension-account-manager": major
"@makaio/extension-coderabbit": major
"@makaio/extension-shell": major
"@makaio/extension-telemetry-otel": minor
"@makaio/framework": major
"@makaio/hooks": major
"@makaio/host-shared": major
"@makaio/kernel": major
"@makaio/runtime-bun": major
"@makaio/runtime-node": major
"@makaio/sdk": minor
"@makaio/services-core": major
"@makaio/services-log-import": major
"@makaio/setup": minor
"@makaio/storage-core": major
"@makaio/subsystem-adapter": major
"@makaio/subsystem-client": major
"@makaio/subsystem-mcp-http-server": major
"@makaio/subsystem-native-session-supervisor": major
"@makaio/subsystem-workflow-engine": major
"@makaio/test-utils": major
"@makaio/tools-core": major
"@makaio/ui-hooks": major
"@makaio/ui-kernel": major
---

Carry a `CallContext` on every bus send. It identifies the sender (`caller`),
the party the work is for (`principal`), and the party that vouches for that
claim when present (`attestedBy`).

Pass the call first to `request`, `requestOptional`, `emit`, and `broadcast`.
Forward `ctx.call` through awaited work, callbacks, and interface methods.
Take the call from each invocation that handles a message.
The sending bus supplies the caller when it forwards a call. For work that
starts independently, obtain a context from `bus.own(purpose)` on the bus that
sends. `OwnWorkPurpose` accepts `start`, `stop`, `schedule`, `observer`,
`shared-work`, and `root`. The call-free send overloads still create an implicit
own context. An explicit own context is bound to its minting bus's carrier.
Sending it on a bus with a different carrier throws `ForeignOwnContextError`.
A received `ctx.call` can cross carriers.

Transports supply caller identity as a `Party` in
`TransportReceiveContext.caller`. In handlers, read sender identity from
`ctx.call.caller`. A local send leaves `ctx.transport` undefined.
`TransportPeerContext`, `TransportReceiveContext.peer`, `MessageOrigin`,
handler-context `origin`, `LOCAL_ORIGIN`, and `REMOTE_ORIGIN` have been removed.
WebSocket HMAC identity registration uses `partyKind` in place of `peerKind`.

A principal travels in `metadata.principal` only from a connection that attests
it; any other connection's messages carry its caller as principal. Attestation
is an explicit opt-in by connection role, decided in one table,
`ATTESTING_CONNECTION_ROLES` in `@makaio/core`: `core-uplink` (a client's
connection to its core host, outbound), `job-run` and `local-cli` (HMAC
identities on the host, inbound). Give each client connection to its core host
`attestingRole: 'core-uplink'` (`WebSocketClientTransport`,
`createMessagePortTransport`, `@makaio/sdk` `BusClientOptions`), and register
the HMAC identities of job runs and the local CLI with their `attestingRole`
(`registerHmacIdentitySecret` no longer takes `attests`;
`hmacIdentityAttests` is now `resolveHmacIdentityAttestingRole`). An own
context is also bound to the bus context that minted it.

### Changed contracts

- `IWorkerProvider.provision` and the four recovery methods
  (`discoverProvisioning`, `attach`, `inspect`, and `terminateAllocation`) take
  the call first, as does `WorkflowMaterializationSpecResolver.resolve(call, input)`.
  Hook contributors receive it in `ContributorCallbackContext.call`.
- Connector movement callbacks `onAdapterSessionMoved`, `onNativeResumeSuppressed`,
  `AdapterSessionPublicationSink`, and `announceAdapterSessionMoved` take the
  call first. Pass it to `BaseConnectorTurn.transitionTo`, `emitStateChange`,
  and `pause(call)`, to `ProceduralAgentConnector.ensureSession(call)`, and to
  `ConnectorSwapCommitGuard(call)`. The lazy tool approval context in
  `ConformanceTestConfig.registerToolApprovalHandler` receives the call.
- Use `registerCodeExecutionProvider(call, bus, provider)` with a
  `Pick<MakaioBusLike, 'emit'>`. Use `createBusInstance()` to create a bus.
  The `@makaio/bus-core` root drops `createBusContext` and `createFilteredBus`.
- The `@makaio/agent-sdk/core` and `@makaio/agent-sdk/runtime` entry points stay
  call-free (`query`, `listSessions`, `getSessionInfo`, `getSessionMessages`,
  `forkSession`, `deleteSession`, `renameSession`, `supportedModels`,
  `mcpServerStatus`) and mint their own root context on the bus they connect.
  The root entry point exposes the shared helpers call-first, for example
  `listSessions(call, bus, options?)`.

### Migration examples

```ts
// Before: sending inside an operation
await bus.request(HarnessStorageSubjects.list, filters);
// After: the operation receives call as its first parameter
await bus.request(call, HarnessStorageSubjects.list, filters);
```

```ts
// Before
bus.on(HarnessSubjects.list, async (ctx) => {
  ctx.setResult(await bus.request(HarnessStorageSubjects.list, ctx.payload));
});
// After
bus.on(HarnessSubjects.list, async (ctx) => {
  ctx.setResult(await bus.request(ctx.call, HarnessStorageSubjects.list, ctx.payload));
});
```

```ts
// Before: starting work without a received message
await bus.request(HarnessStorageSubjects.list, filters);
// After: name the origin on the sending bus
await bus.request(bus.own('start'), HarnessStorageSubjects.list, filters);
```
