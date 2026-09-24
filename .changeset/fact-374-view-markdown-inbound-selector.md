---
"@makaio/contracts": minor
"@makaio/services-core": minor
---

Publish `renderArtifactViewMarkdown` (with `includeTitle` option) and `ARTIFACT_VIEW_MARKDOWN_RENDERER_VERSION` from `@makaio/contracts/materialization` as the surface-neutral Markdown renderer for `ArtifactViewModel`. Add `direction: 'inbound'` to `ArtifactContextRelationSelector`: `resolveArtifactContext` now also selects the current revisions of artifacts whose relations point at the walked artifact's identity, recorded as context edges with `direction: 'inbound'` on the wire entry and the hydrated tree node.
