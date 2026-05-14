import { createBusNamespace } from '@makaio/core';
import { ConfigSchemas } from './config-subjects.js';

/**
 * Config namespace definition.
 * Defines the `config` subjects for explicit registration by composition roots.
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
export const ConfigNamespace = createBusNamespace('config', ConfigSchemas);

/**
 * Config subjects for type-safe bus communication.
 */
export const ConfigSubjects = ConfigNamespace.subjects;
