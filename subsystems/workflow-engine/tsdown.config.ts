import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  dts: { eager: true },
  entry: [
    './src/index.ts',
    './src/package.ts',
    './src/workflow-orchestrator.ts',
    './src/execution-attempt-repository.ts',
    './src/provider-operation.ts',
    './src/testing/index.ts',
    './src/testing/sqlite.ts',
  ],
});
