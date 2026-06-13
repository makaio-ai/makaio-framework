# @makaio/provider-cursor

Type-only provider definition for Cursor's SDK-based models. Cursor uses its
own SDK transport rather than a standard OpenAI or Anthropic HTTP endpoint, so
this package declares provider identity and credential metadata without runtime
network code.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `cursor` |
| `name` | `Cursor` |
| `defaultModel` | `composer-2.5` |
| `fastModel` | `composer-2` |
| `credentialEnvVars.apiKey` | `CURSOR_API_KEY` |

## Exports

The root entrypoint exports `providerDefinition` and `cursorProviderPackage`.
The `./server` entrypoint default-exports the descriptor package used by
framework extension discovery.

## License

MIT
