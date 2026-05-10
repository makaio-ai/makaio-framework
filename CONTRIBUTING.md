# Contributing to Makaio Framework

Thank you for your interest in contributing! Makaio is an open-source project
under MIT, and we welcome contributions of all kinds — bug reports, bug fixes,
new adapters, extensions, tools, documentation improvements, and ideas.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Development Setup

```bash
# Clone and install
git clone https://github.com/makaio-ai/makaio-framework.git
cd makaio-framework
yarn install

# Validate (types + lint + format — run this before every PR)
yarn validate

# Run tests for a specific package or file
yarn test path/to/package-or-test-file

# Format only
yarn format
```

There is no build step during development — `vite-tsconfig-paths` resolves
`@makaio/*` imports from source.

## Where to Contribute

There are three primary contribution surfaces, each with its own guide:

### Adapters — New AI Provider Bridges

Implement the three-layer contract (Adapter > Agent > Connector), run the
shared conformance test suite, and submit a PR.

The conformance tests make real API calls against each provider, so they
require valid credentials and incur usage costs. Run them for the adapter(s)
you changed before submitting:

```bash
# Run conformance tests for a specific adapter
yarn test:conformance --adapter openai-node
```

See [Creating Adapters](docs/creating-adapters.md).

### Extensions — New Capabilities

Extensions contribute services, CLI commands, HTTP routes, storage handlers,
desktop windows, and browser UI. The framework provides scaffolding
(`makaio extension init`), verification (`makaio extension verify`), and a
build preset.

See [Extension Model](docs/extensions.md).

### Tools — New Agent Capabilities

The lowest-barrier entry point. Define a tool with `defineTool()`, group it
into a toolset with `defineToolset()`, and register it on the bus. Every agent
can then discover and use it.

See [Getting Started — Writing a Tool](docs/getting-started.md).

## Code Conventions

- **TypeScript** — strict mode, no `any`, no `as unknown as`
- **JSDoc / TSDoc** — all public APIs, including `@param` tags
- **DRY** — if you see repeated patterns, abstract them
- **No comments by default** — only add one when the "why" is non-obvious
- **Validation** — `yarn validate` runs Prettier, ESLint, Stylelint, and
  TypeScript in parallel. Run it before every PR; CI will reject failures.
- **Tests** — test real implementations, not mocks

## Submitting a Pull Request

1. Fork the repository and create a branch from `develop`
2. Make your changes — keep PRs focused on a single concern
3. Run `yarn validate` and fix any issues
4. Run relevant tests with `yarn test path/to/package`
5. Open a PR against `develop` with a clear description of what changed and why

For bug reports and feature requests, open a
[GitHub issue](https://github.com/makaio-ai/makaio-framework/issues) first to
discuss the approach before investing time in implementation.
