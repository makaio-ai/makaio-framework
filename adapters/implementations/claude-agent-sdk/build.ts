import { buildAdapterPackage } from '@makaio/build-tooling/tsdown-adapter-build';

await buildAdapterPackage({
  packageDir: import.meta.dirname,
  entry: {
    index: './src/index.ts',
    server: './src/server.ts',
  },
  bundledFrameworkPackages: ['@makaio/ai-adapters-claude-shared'],
  external: [/^@anthropic-ai\//, 'p-defer', 'p-queue'],
  needsCreateRequire: true,
});
