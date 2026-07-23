---
"@makaio/contracts": minor
"@makaio/subsystem-client": minor
---

Expose the host extension context to client hook response contributor factories.

- `ContributorActivationContext` and `ExtensionClientHookResponsesContribution` are now generic over `THostContext extends ExtensionContext` (defaulting to `ExtensionContext`) and carry a required `extensionContext` field
- `MakaioExtension.clientHookResponses` threads the manifest's `THostContext` through the contribution surface
- `ClientHookResponseContributionProcessor` forwards the activation's `KernelExtensionContext`, so contributor factories can capture the typed bus, service lookup, and shutdown signal instead of relying on module-global state
- Breaking for hosts that construct `ContributorActivationContext` literals outside the built-in processor: the new `extensionContext` field must be supplied
