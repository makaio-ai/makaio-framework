# @makaio/adapter-cursor-sdk

Cursor SDK adapter for the Makaio framework. The adapter wraps Cursor's
TypeScript SDK behind the standard Adapter -> Agent -> Connector contract while
leaving Cursor's SDK-owned agentic loop intact.

## Architecture

| Layer | Export | Responsibility |
|-------|--------|----------------|
| Adapter | `CursorSdkAdapter` | Adapter lifecycle and framework registration |
| Agent | `CursorSdkAgent` | Agent event normalization and turn coordination |
| Connector | `CursorSdkConnector` | Cursor SDK session creation and streaming |
| Session | `CursorSdkSession` | Cursor conversation state and turn execution |

## Provider And Client

This adapter serves the `cursor` provider directly through `@cursor/sdk`; it has
no managed client or Makaio HTTP protocol. Select the provider's explicit API-key
method, using `CURSOR_API_KEY` as an environment source when desired.

## Exports

The root entrypoint exports the adapter classes, config schema, namespace
subjects, provider metadata, and descriptor package. The `./server` entrypoint
default-exports the `cursorSdkPackage` descriptor for framework extension
discovery.

## Usage Telemetry

`agent.usage` is emitted once per completed message/turn from the SDK's usage
event. The SDK may report an optional monetary amount, forwarded as `cost`
(omitted entirely when the SDK reports no amount). The SDK exposes no provider
call ID, so `llmCallId` is never set. See
[Usage & Provenance](../../../docs/architecture/adapters/usage-and-provenance.md).

## License

MIT
