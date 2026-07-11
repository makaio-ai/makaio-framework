import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  dts: false,
  entry: {
    index: './src/index.ts',
    'client-binary-strategy-dependencies': './src/client-binary-strategy-dependencies.ts',
    'extension-discovery': './src/extension-discovery.ts',
    'extension-validation': './src/extension-validation.ts',
    'makaio-config': './src/makaio-config.ts',
    'bus/runtime/schemas': './src/bus/runtime/schemas.ts',
    'bus/runtime/namespace': './src/bus/runtime/namespace.ts',
    'workflow-worker/index': './src/workflow-worker/index.ts',
    'workflow-worker/worker-entry': './src/workflow-worker/worker-entry.ts',
  },
});
