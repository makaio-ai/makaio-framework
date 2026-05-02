import { MakaioBus } from '@makaio/bus-core';
import { ConfigSchemas } from './config-subjects.js';

/**
 * Config namespace registration.
 * Registers the 'config' namespace with the bus.
 * @example
 * ```typescript
 * // Get current config
 * const result = await bus.request(ConfigSubjects.get, {});
 * console.log(result.config);
 *
 * // Update config
 * await bus.request(ConfigSubjects.update, { config: newConfig });
 * ```
 */
export const ConfigNamespace = MakaioBus.registerNamespace('config', ConfigSchemas);

/**
 * Config subjects for type-safe bus communication.
 */
export const ConfigSubjects = ConfigNamespace.subjects;
