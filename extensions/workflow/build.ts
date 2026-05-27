import { build } from 'tsdown';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';
import { workflowExtensionConfig } from './build-config.js';

await build(workflowExtensionConfig);

emitDeclarations({ packageDir: import.meta.dirname });
