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

This adapter serves the `cursor` provider and declares the `cursor` client as
its native client dependency. Install `@cursor/sdk` as a peer dependency and
provide credentials through `CURSOR_API_KEY` when required by the SDK.

## Exports

The root entrypoint exports the adapter classes, config schema, namespace
subjects, provider metadata, and descriptor package. The `./server` entrypoint
default-exports the `cursorSdkPackage` descriptor for framework extension
discovery.

## License

MIT
