import { buildAdapterPackage } from '@makaio/build-tooling/tsdown-adapter-build';

await buildAdapterPackage({
  packageDir: import.meta.dirname,
  entry: {
    index: './src/index.ts',
    server: './src/server.ts',
  },
  external: [/^@github\//, 'p-defer', 'p-queue', 'quick-lru'],
});
