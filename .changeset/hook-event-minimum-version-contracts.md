---
"@makaio/contracts": minor
---

Add optional `minimumVersion` to hook-event declarations.

`ClientHookEventDeclarationSchema` now accepts an optional `minimumVersion`
semver-literal field. When absent the event is available across the whole
`supportedVersions` range of the client; when present the wiring layer can
use it to skip events whose minimum lies above the detected binary version.
