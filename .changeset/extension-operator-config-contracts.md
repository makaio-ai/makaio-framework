---
"@makaio/contracts": minor
"@makaio/framework": minor
---

Add the operator extension config contract: `ExtensionOperatorConfigSource`,
`ExtensionOperatorConfigEntry` (`config` | `failure` with reasons `unreadable`,
`invalid-json`, `not-an-object`) and the percent-encoding helpers
`encodeExtensionOperatorConfigName` / `decodeExtensionOperatorConfigName` that
map an extension name to its `$MAKAIO_HOME/config/extensions/<name>.json` file
stem and back. Encoding answers `undefined` for a name no file can address — the
empty name, a dot segment, or a name that is not well-formed Unicode — so one
stem never stands for two extensions.

The kernel resolves extension config from four layers, highest wins: operator
file, stored records, host `makaio.config.*` defaults, descriptor defaults. A
malformed operator file or a file that breaks the extension's `configSchema`
fails only that extension with a source-attributed error; the rest of the
runtime boots. The snapshot is read once at boot and stays fixed until restart.
