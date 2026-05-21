import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  dts: false,
  entry: [
    './src/adapter/index.ts',
    './src/adapter/schemas/session-lineage.ts',
    './src/client/index.ts',
    './src/common/index.ts',
    './src/config/index.ts',
    './src/extension/index.ts',
    './src/harness/index.ts',
    './src/index.ts',
    './src/native-session-supervisor/index.ts',
    './src/provider/index.ts',
    './src/session/index.ts',
    './src/shared/index.ts',
    './src/skill/index.ts',
    './src/toast/index.ts',
  ],
});
