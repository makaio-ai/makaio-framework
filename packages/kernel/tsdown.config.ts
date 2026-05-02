import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  entry: [
    './src/index.ts',
    './src/cli/index.ts',
    './src/cli/schemas.ts',
    './src/cli/register.ts',
    './src/extension/index.ts',
    './src/namespace/index.ts',
    './src/observability/index.ts',
    './src/providers/index.ts',
    './src/window/index.ts',
  ],
});
