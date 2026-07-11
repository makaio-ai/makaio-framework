# @makaio/provider-cursor

Type-only provider definition for Cursor's SDK-based models. Cursor uses its
own SDK transport rather than a standard OpenAI or Anthropic HTTP endpoint, so
this package declares provider identity and authentication metadata without runtime
network code.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `cursor` |
| `name` | `Cursor` |
| `defaultModel` | `composer-2.5` |
| `fastModel` | `composer-2` |

## Authentication

| Method | Mode | Fields and sources | Adapter delivery |
|--------|------|--------------------|------------------|
| `api-key` | `explicit` | Required `apiKey`; `CURSOR_API_KEY` is an environment source hint | Cursor SDK `Agent.create` |

The environment variable is one explicit credential source, not an ambient
fallback. The adapter scrubs competing Cursor inputs and passes only the
selected key to the SDK boundary.

## Exports

The root entrypoint exports `providerDefinition` and `cursorProviderPackage`.
The `./server` entrypoint default-exports the descriptor package used by
framework extension discovery.

## License

MIT
