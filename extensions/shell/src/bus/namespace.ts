import { createExtensionNamespace } from '@makaio/bus-core';
import { ShellServiceSchemas } from './schemas.js';

export const ShellNamespace = createExtensionNamespace('shell', {
  schemas: ShellServiceSchemas,
});

export const ShellSubjects = ShellNamespace.subjects;
