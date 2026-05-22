import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { extensionToken } from '@makaio/contracts';
import { LogImportRegistry } from './log-import-registry.js';
import { LogImportNamespace } from './namespace.js';

/** Token for the log import registry package. */
export const LogImportRegistryToken = extensionToken<LogImportRegistry>('log-import-registry');

/** Package that starts the framework log import registry. */
export const logImportRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: LogImportRegistryToken.name,
  displayName: 'Log Import Registry',
  version: '0.1.0',
  critical: true,
  namespaces: [LogImportNamespace],
  create: (ctx) => new LogImportRegistry({ bus: ctx.bus }),
};
