import { fileURLToPath } from 'node:url';
import type { CanonicalizeContext } from 'sass';
import { describe, expect, it } from 'vitest';
import { createMakaioScssImporter } from './tsdown-scss.js';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const context = {
  containingUrl: null,
  fromImport: false,
} satisfies CanonicalizeContext;

describe('createMakaioScssImporter', () => {
  it('resolves the theme package root to its SCSS entrypoint', async () => {
    const importer = createMakaioScssImporter(workspaceRoot);

    expect((await importer.findFileUrl('@makaio/ui-theme', context))?.pathname).toBe(
      new URL('../ui/theme/index.scss', import.meta.url).pathname,
    );
  });

  it('resolves package partial imports using Sass underscore conventions', async () => {
    const importer = createMakaioScssImporter(workspaceRoot);

    expect((await importer.findFileUrl('@makaio/ui-theme/tokens/colors', context))?.pathname).toBe(
      new URL('../ui/theme/tokens/_colors.scss', import.meta.url).pathname,
    );
  });

  it('returns null for imports outside the framework SCSS package contract', async () => {
    const importer = createMakaioScssImporter(workspaceRoot);

    expect(await importer.findFileUrl('@makaio/ui-components', context)).toBeNull();
    expect(await importer.findFileUrl('@makaio/ui-theme/tokens/not-real', context)).toBeNull();
    expect(await importer.findFileUrl('@makaio/ui-theme/../../package.json', context)).toBeNull();
  });

  it('does not resolve directory URLs as Sass modules', async () => {
    const importer = createMakaioScssImporter(workspaceRoot);

    expect((await importer.findFileUrl('@makaio/ui-theme/themes/aura.scss', context))?.pathname).toBe(
      new URL('../ui/theme/themes/aura.scss', import.meta.url).pathname,
    );
    expect((await importer.findFileUrl('@makaio/ui-theme/themes', context))?.pathname).toBe(
      new URL('../ui/theme/themes/_index.scss', import.meta.url).pathname,
    );
    expect(await importer.findFileUrl('@makaio/ui-theme/_internal', context)).toBeNull();
  });
});
