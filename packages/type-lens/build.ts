import { build, defineConfig } from 'tsdown';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build(
  defineConfig({
    entry: {
      index: './src/index.ts',
      schemas: './src/schemas.ts',
      'index-engine': './src/index-engine.ts',
      'index-query': './src/index-query.ts',
      'index-types': './src/index-types.ts',
      'index-utils': './src/index-utils.ts',
      'member-extractor': './src/member-extractor.ts',
      'source-filter': './src/source-filter.ts',
      'symbol-extractor': './src/symbol-extractor.ts',
      'type-analysis': './src/type-analysis.ts',
      'tsci-analyzer': './src/tsci-analyzer.ts',
      'storage/vector-math': './src/storage/vector-math.ts',
    },
    format: 'esm',
    platform: 'node',
    dts: false,
    minify: false,
    deps: {
      neverBundle: ['ts-morph', 'typescript', 'zod', 'quick-lru'],
    },
  }),
);

emitDeclarations({ packageDir: import.meta.dirname });
