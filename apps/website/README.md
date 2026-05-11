# @makaio/website

The Makaio Framework documentation and marketing website, built with [Astro Starlight](https://starlight.astro.build). It is published at [makaio.ai](https://makaio.ai) and serves as the primary developer reference: guides, package overviews, bus subject contracts, TypeScript API reference, and multi-language SDK documentation.

## Architecture Role

The website is a standalone build-time surface — it has no runtime dependency on the Makaio bus or kernel. Instead, it consumes the framework source statically at build time: custom Astro integrations analyze TypeScript source files to generate API reference pages, bus subject contract pages, and package overview pages from each package's `README.md`.

```
framework source (TypeScript, READMEs, bus namespaces)
  │  build-time analysis (Astro integrations + TypeDoc)
  ▼
@makaio/website  (Astro Starlight site)
  │  astro build
  ▼
Static site published to makaio.ai
```

## Features

- **Guides** — conceptual documentation covering the bus, extensions, adapters, CLI, transport, configuration, and desktop apps.
- **API reference** — TypeDoc-generated TypeScript symbol reference, auto-built at site build time from framework source.
- **Bus subjects reference** — generated pages for every bus event and RPC subject namespace, produced by the `namespace-analyzer` build library.
- **Package pages** — one page per framework package, sourced from each package's `README.md` via the `generate-package-pages` integration.
- **SDK documentation** — overview pages for the TypeScript, Python, and Rust SDKs.
- **LLMs.txt** — `starlight-llms-txt` generates curated plain-text bundles (abridged and full) for large-context AI consumption.
- **Remark plugins** — custom pipeline: `remarkAutoLinkApi` and `remarkAutoLinkPackages` auto-link `@makaio/*` package specifiers and API symbols; `remarkWebHide` strips content marked for web exclusion; `remarkStripMdLinks` normalizes `.md` links.
- **Mermaid diagrams** — `rehype-mermaid` renders diagram code blocks as inline SVG images at build time.

## Development

```bash
# Start Astro dev server with live rebuild
yarn dev

# Production build (generates API reference, bus subjects, package pages)
yarn build

# Preview the production build locally
yarn preview
```

The build requires access to the full framework source tree. The `generate-api-reference` integration calls TypeDoc and the `generate-bus-subjects` integration runs the `namespace-analyzer` scripts; both resolve paths relative to the framework root (`../../..` from the package directory).

## Key Files

| Path | Purpose |
|------|---------|
| `astro.config.ts` | Site configuration — Starlight setup, sidebar structure, remark/rehype pipeline, LLMs.txt |
| `integrations/generate-package-pages.ts` | Reads each framework package's `README.md` and emits Starlight content pages |
| `integrations/generate-api-reference.ts` | Runs TypeDoc and emits `reference/api/**` content pages |
| `integrations/generate-bus-subjects.ts` | Runs the namespace analyzer and emits `reference/subjects/**` content pages |
| `integrations/compose-llms-full.ts` | Assembles the full large-context LLMs.txt bundle |
| `remark/auto-link-api.ts` | Remark plugin — auto-links TypeScript API symbols in prose |
| `remark/auto-link-packages.ts` | Remark plugin — auto-links `@makaio/*` package specifiers |
| `remark/web-hide.ts` | Remark plugin — strips content blocks marked web-only hidden |
| `src/content/docs/` | Authored MDX/Markdown guide content |
| `src/components/` | Starlight component overrides (Header, Hero, Sidebar, SiteTitle) |
| `src/styles/aura.css` | Custom CSS theme (Aura color palette) |

## Installation

Private workspace package — not published to npm. Deployed as a static site to [makaio.ai](https://makaio.ai).
