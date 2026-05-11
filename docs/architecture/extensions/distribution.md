---
title: Distribution
description: Extension distribution, descriptor-selected loading, and local authoring workflow.
---

## Extension distribution

Extensions are loaded through the same descriptor-driven discovery pipeline. The host selects
the descriptor graph through config and discovery inputs; the `ExtensionCoordinator` receives
that graph and starts every selected extension through one dependency model.

Extension inclusion is selected by runtime config and descriptor discovery inputs.
There is no alternate CLI entrypoint or separate boot path for different descriptor sources.

Extensions that need a post-coordinator barrier may subscribe to the runtime phase
broadcast during `create()` / `init()`. The barrier payload is intentionally small and
typed. Contribution/catalog data lives on dedicated bus request subjects; for example,
active provider and client definitions are queried through
`ExtensionSubjects.contributions.catalog`. Contribution surfaces do not use phase
broadcasts: tools, log imports, triggers, session event actions, and adapters are wired
by awaited `ContributionProcessor` instances registered from `boot.ts`.

| Phase subject | Emitted after | Typical use |
|---------------|---------------|-------------|
| `kernel.phase.coordinatorReady` | all coordinator extensions started | settings barrier, final startup integration |

```ts
import { KernelSubjects } from '@makaio/kernel';

export const settingsIntegrationExtension: MakaioExtension = {
  name: 'my-ext.settings-integration',
  displayName: 'Settings Integration',
  dependencies: ['my-ext.credential'],
  critical: true,
  create: (ctx) => {
    const unsubscribe = ctx.bus.on(KernelSubjects.phase.coordinatorReady, async (phaseCtx) => {
      const catalog = await ctx.bus.request(ExtensionSubjects.contributions.catalog, {});
      // post-coordinator wiring using typed request seams
      phaseCtx.setResult({});
    });
    return { destroy: () => unsubscribe() };
  },
};
```

Use `critical: true` for extensions that must exist for safe boot. Use
`ServiceSkipError` only from non-critical extensions whose absence is intentional for the
current host or feature flag.

## Local authoring workflow

The currently supported authoring path on `develop` is repo-local authoring
inside the framework workspace.

Framework-owned CLI builtins support that workflow:

- `makaio extension init <name>`
- `makaio extension verify`

### What `init` generates

`makaio extension init` creates a local extension workspace with:

- `.gitignore`
- `package.json`
- `descriptor.json`
- `tsconfig.json`
- `tsconfig.repo-dev.json`
- `tsdown.config.ts`
- `vitest.config.ts`
- `README.md`
- `scripts/package-mode.ts`
- `scripts/run-with-mode.ts`
- `scripts/prepare-portable-package.mjs`
- `test/verify.test.ts`
- selected `src/server.ts`, `src/browser.ts`, and `src/cli.ts` files

`descriptor.json` remains the canonical install/discovery contract. The scaffold
does not introduce a second runtime manifest.

The generated extension source tree now has an explicit two-mode contract:

- repo-dev mode for contributors working inside the framework repo
- portable staged package mode via `yarn prepare:portable-package`

This is intentionally explicit. The framework does not silently switch between
local-source and published-package resolution.

Run `yarn install` in the generated extension before invoking `yarn build`,
`yarn test`, or `yarn verify`. `yarn prepare:portable-package` can run before
that install step.

### What `verify` checks

`makaio extension verify` validates the local workspace against the current
authoring contract:

- `descriptor.json` parses against `ExtensionDescriptor`
- declared entrypoints resolve to an existing `src/<stem>.ts` or `dist/<stem>.mjs` within the extension root
- server entry default export is `MakaioExtension`-like
- CLI entry default export is an executable `CliContribution`
- browser bundle is parseable/loadable ESM
- browser bundle uses only framework-owned shared browser externals (`react`, `react-dom`,
  `react/jsx-runtime`, `@makaio/web-framework`)
- browser bundle remains compatible with the host `/extensions/<name>/browser/*`
  static-root contract

The verifier exposes structured diagnostics internally and prints concise
human-readable failures in the CLI.

### npm Trusted Publishing

Publishing uses npm Trusted Publishing from the manual `.github/workflows/npm-publish.yml` workflow. Configure each public package on npmjs.com with:

- GitHub organization/user: the Makaio repository owner
- GitHub repository: the Makaio repository name
- Workflow filename: `npm-publish.yml`
- Environment name: `npm-production`

Do not create or store `NPM_TOKEN` for publish automation. The workflow publishes from GitHub-hosted runners with OIDC (`id-token: write`). npm automatically creates provenance attestations for public packages published through Trusted Publishing.

## Current status

### Extension distribution

**Status:** Local framework source checkout authoring is implemented through
`makaio extension init`, `makaio extension verify`, the tsdown extension preset,
and framework-owned shared browser externals. The remaining gap is the final
standalone published npm story outside the framework workspace.

### Browser extension loading from npm packages

**Status:** `ExtensionBrowserLoader` loads browser bundles declared via `browser.entrypoint`.
Restart-time loading from npm-installed extensions is implemented through descriptor
discovery plus boot-time static mounts. Import-map generation and shared dependency
resolution are now wired for the supported local framework source checkout authoring path.
The remaining gap is the standalone production/distribution story for browser bundles
outside this workspace.

### Dynamic extension loading after boot

**Status:** `FilesystemDescriptorDiscovery` is the boot-time descriptor source.
Installing a new extension package after a desktop host has started still
requires a restart for HTTP route changes because Hono routes cannot be removed
from the existing app. The current coordinator public API is boot-time `load()`
plus lifecycle start/stop/toggle operations; there is no public post-boot
extension graph registration contract.

### Descriptor-selected extension loading

**Status:** `ExtensionCoordinator` loads the descriptor graph selected by the host's
configured discovery inputs. Eligibility policy belongs to the host before it hands
descriptors to the framework runtime; the framework coordinator only sees the resulting
descriptor set.
