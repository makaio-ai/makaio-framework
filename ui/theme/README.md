# @makaio/ui-theme

SCSS-only design tokens, mixins, functions, and the Aura theme for framework UI packages.

## Package Surface

- Workspace package: `@makaio/ui-theme`
- No assembled `@makaio/framework/ui-theme` JavaScript subpath is exported.
- Theme files are internal SCSS assets unless a consuming package explicitly exposes its compiled
  stylesheet.

## Boundary

- No production JavaScript or TypeScript exports.
- Consumers import SCSS through `@use` or the package stylesheet entry.
- Runtime theme switching is expressed through CSS custom properties supplied by theme SCSS.

## Current Surface

- `index.scss` loads the package-level stylesheet surface.
- `tokens/` contains colors, spacing, typography, opacity, shadows, graph colors, and terminal
  tokens.
- `mixins/` contains reusable SCSS helpers for forms, navigation, transitions, scrollbars,
  approval UI, glass surfaces, and animations.
- `themes/aura.scss` defines the current Aura theme values.
