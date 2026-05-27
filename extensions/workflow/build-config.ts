import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export const workflowRuntimeExternals = ['@makaio/runtime-node', /^@makaio\/runtime-node\//] as const;

export const workflowExtensionConfig = defineExtensionConfig({
  entry: {
    cli: './src/cli.ts',
  },
  external: workflowRuntimeExternals,
});
