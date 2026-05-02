import type { MakaioExtension } from '@makaio/contracts';
import { extensionToken } from '@makaio/contracts';
import { LogImportRegistry } from './log-import-registry.js';

/** Token for the log import registry package. */
export const LogImportRegistryToken = extensionToken<LogImportRegistry>('log-import-registry');

/** Package that starts the framework log import registry. */
export const logImportRegistryPackage: MakaioExtension = {
  name: LogImportRegistryToken.name,
  displayName: 'Log Import Registry',
  critical: true,
  create: (ctx) => new LogImportRegistry({ bus: ctx.bus }),
};
