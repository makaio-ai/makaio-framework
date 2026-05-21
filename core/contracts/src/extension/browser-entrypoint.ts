import { z } from 'zod';

/**
 * Browser entrypoint metadata declared by a package manifest.
 *
 * The renderer uses this URL path to load a package's browser bundle.
 */
export const BrowserEntrypointSchema = z.object({
  /**
   * URL path the renderer fetches to load the extension's UI.
   * Must be an absolute path (starts with `/`). The loader additionally
   * enforces a `/extensions/` prefix at runtime as defence-in-depth.
   */
  entrypoint: z.string().startsWith('/', { message: 'Entrypoint must be a URL path starting with "/"' }),
});

/** Inferred type for browser entrypoint manifest metadata. */
export type BrowserEntrypoint = z.infer<typeof BrowserEntrypointSchema>;
