import { build } from 'tsdown';
import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineAdapterConfig({
    entry: {
      index: './src/index.ts',
    },
    // `pg` is loaded at runtime through a bundler-opaque dynamic import and
    // `drizzle-orm` is a regular dependency shared with the framework — both
    // stay external so the engine bundle never inlines driver or ORM code.
    external: ['pg', /^drizzle-orm(\/|$)/],
  }),
  dts: false,
});

emitDeclarations({ packageDir: import.meta.dirname });
