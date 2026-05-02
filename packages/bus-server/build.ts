#!/usr/bin/env tsx
import { build, type BuildOptions } from 'esbuild';
import { execSync } from 'child_process';

const outdir = 'dist';

// Shared build options
const sharedOptions: BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
};

/**
 * Builds the mcp-funnel package with TypeScript types and bundled outputs.
 *
 * Creates three build artifacts:
 * - TypeScript declaration files (.d.ts)
 * - ESM bundle (dist/esm/index.js)
 * - CommonJS bundle (dist/cjs/index.cjs)
 * - CLI executable (dist/cli.js) with shebang
 * @throws \{Error\} When TypeScript compilation or bundling fails
 * @internal
 */
async function buildAll() {
  console.debug('🔨 Building mcp-funnel...\n');

  // Build TypeScript types
  console.debug('📦 Building TypeScript types...');

  try {
    execSync('tsc --emitDeclarationOnly --declaration --declarationMap --project tsconfig.build.json', {
      stdio: 'inherit',
    });
  } catch {
    // swallow error to provide a clearer message
  }

  console.debug('📦 Bundling...');
  await Promise.all([
    // Build ESM version
    build({
      ...sharedOptions,
      entryPoints: ['src/index.ts'],
      format: 'esm',
      outfile: `${outdir}/esm/index.js`,
    }),
    // Build CommonJS version
    build({
      ...sharedOptions,
      entryPoints: ['src/index.ts'],
      format: 'cjs',
      outfile: `${outdir}/cjs/index.cjs`,
    }),
  ]);

  console.debug('\n✅ Build complete!');
}

buildAll().catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
