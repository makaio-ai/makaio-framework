/**
 * Bun build plugin that embeds Drizzle migration SQL at build time.
 *
 * Intercepts `@makaio/storage-migrations` and replaces `readMigrations()`
 * with a version that returns pre-computed {@link MigrationMeta} constants.
 * This eliminates filesystem access for migrations in the bundled Electrobun
 * app — no temp dirs, no path resolution, no archive gotchas.
 *
 * @example
 * ```ts
 * await Bun.build({
 *   extensions: [embeddedMigrationsPlugin(MIGRATION_SOURCES)],
 *   // ...
 * });
 * ```
 *
 * @param migrationSources - Build-time migration sources to embed.
 * @returns Bun plugin instance.
 */
import type { BunPlugin } from 'bun';
import {
  type EmbeddedMigrationSource,
  loadEmbeddedMigrations,
  renderEmbeddedMigrationsModule,
} from '../../../host-shared/src/build/embedded-migrations.ts';

/**
 * Create a Bun build plugin that embeds Drizzle migrations at build time.
 *
 * Reads every bundled migration source up front and generates a virtual module
 * that resolves `readMigrations()` from an embedded source-id map while still
 * honoring known source-directory aliases.
 * @param migrationSources - Build-time migration sources.
 * @param defaultMigrationSourceId - Default source id used when callers omit input.
 * @returns Bun {@link BunPlugin}.
 */
export function embeddedMigrationsPlugin(
  migrationSources: readonly EmbeddedMigrationSource[],
  defaultMigrationSourceId?: string,
): BunPlugin {
  const embeddedMigrations = loadEmbeddedMigrations(migrationSources);
  return {
    name: 'embedded-migrations',
    setup(build) {
      // Intercept bare-specifier imports of @makaio/storage-migrations.
      // onResolve fires BEFORE Bun's default resolution, so this
      // catches the import before it resolves to the filesystem.
      build.onResolve({ filter: /^@makaio\/storage-migrations$/ }, () => ({
        path: '@makaio/storage-migrations',
        namespace: 'embedded-migrations',
      }));

      // Provide a virtual module with embedded migration data keyed by stable
      // source id, while preserving known source-directory aliases for
      // bundled callers that still pass a raw migrations path.
      build.onLoad({ filter: /.*/, namespace: 'embedded-migrations' }, () => ({
        contents: renderEmbeddedMigrationsModule(embeddedMigrations, defaultMigrationSourceId),
        loader: 'js',
      }));
    },
  };
}
