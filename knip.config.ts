import type { KnipConfig } from 'knip';

/**
 * Framework knip configuration.
 *
 * Run from the framework root: `npx knip`
 *
 * Entry points are auto-discovered from each workspace's package.json `exports`
 * field. Only workspaces with non-standard entry patterns need overrides.
 *
 * Use `@public` JSDoc tags on entry-file re-exports that are consumed outside
 * the framework (e.g. by host code). Tags suppress "unused export" warnings
 * for symbols knip cannot trace statically.
 */
const config: KnipConfig = {
  workspaces: {
    // --- Application entry overrides ---

    'apps/cli': {
      entry: ['src/cli-entry.ts'],
    },
    'apps/electron': {
      entry: ['src/main/main-entry.ts', 'src/cli-entry.ts', 'src/main/preload.cjs'],
    },
    'apps/electrobun': {
      entry: ['src/main/main-entry.ts', 'electrobun.config.ts'],
    },

    // --- Statically imported packages: enable entry export analysis ---
    // These packages are imported via normal `import` statements, so knip can
    // trace which exports are actually consumed. Dead exports are reliable.

    'packages/*': { includeEntryExports: true },
    'adapters/core': { includeEntryExports: true },
    'tools/*': { includeEntryExports: true },
    'transports/*': { includeEntryExports: true },
    'build-tooling': { includeEntryExports: true },

    // --- Fully public UI packages: skip entry export analysis ---
    // These packages expose framework UI extension points and component APIs as
    // public surface. Standalone entry-export analysis would report intentionally
    // public symbols as dead because downstream hosts consume them outside this
    // repository boundary.

    'ui/kernel': { includeEntryExports: false },
    'ui/components': { includeEntryExports: false },

    // --- Dynamically imported packages: skip entry export analysis ---
    // Packages with descriptor.json are loaded at runtime via
    // ExtensionCoordinator / FilesystemDescriptorDiscovery. Knip cannot trace
    // `import(pathToFileURL(entryPath).href)` so all exports appear "unused."
    // Only dependencies, devDependencies, files, and unlisted findings are
    // trustworthy for these packages.

    'adapters/implementations/*': { includeEntryExports: false },
    'adapters/shared/*': { includeEntryExports: false },
    'clients/*': { includeEntryExports: false },
    'extensions/*': { includeEntryExports: false },
    'providers/*': { includeEntryExports: false },
  },

  ignore: ['**/dist/**', '**/.tmp/**', '**/.archive/**', '**/drizzle/**', 'e2e/**', '**/*.scss', '**/*worker*.mjs'],

  exclude: ['enumMembers'],

  tags: ['+public'],
};

export default config;
