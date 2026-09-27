---
'@makaio/agent-sdk': major
'@makaio/contracts': major
'@makaio/framework': major
---

Remove the Gemini and GitHub Copilot integrations.

The packages `@makaio/adapter-gemini-sdk`, `@makaio/adapter-github-copilot-sdk`,
`@makaio/client-gemini`, `@makaio/client-github-copilot`, `@makaio/provider-google` and
`@makaio/provider-github-copilot` are deleted from the workspace and will receive no
further releases. The two provider packages had no consumer other than the removed
adapters.

**Breaking:**

- `@makaio/contracts` no longer exports `GEMINI_SDK_REGISTRY_HARNESS`, and
  `DEFAULT_HARNESSES` no longer seeds the `harness-gemini-sdk-registry` default harness.
- The bundled model-registry seed no longer lists the `google`, `google-oauth` and
  `github-copilot` providers. The Google lab (Gemini model metadata) stays in the
  registry, so other providers can still attribute Gemini models to it.
- `@makaio/agent-sdk` no longer bundles the Gemini and Copilot adapters or their
  providers, so `gemini-sdk::…` and `github-copilot-sdk::…` model references no longer
  resolve.
