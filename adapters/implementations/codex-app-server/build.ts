import { buildAdapterPackage } from '@makaio/build-tooling/tsdown-adapter-build';

await buildAdapterPackage({
  entry: {
    index: './src/index.ts',
    server: './src/server.ts',
  },
});
