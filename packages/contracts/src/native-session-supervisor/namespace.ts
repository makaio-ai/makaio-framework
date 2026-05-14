/**
 * Native Session Supervisor namespace definition.
 *
 * Defines the global `native-session-supervisor.*` subjects for launching,
 * attaching to, stopping, and querying supervised native process runtimes.
 * @packageDocumentation
 */

import { createBusNamespace } from '@makaio/core';
import { NativeSessionSupervisorSchemas } from './schemas.js';

/**
 * MakaioBus namespace definition under the `native-session-supervisor` prefix.
 */
export const NativeSessionSupervisorNamespace = createBusNamespace(
  'native-session-supervisor',
  NativeSessionSupervisorSchemas,
);

/**
 * Typed bus subjects for the native-session-supervisor namespace.
 * @example
 * ```typescript
 * // Launch a new supervised runtime
 * bus.emit(NativeSessionSupervisorSubjects.launch, {
 *   clientId: 'claude-code',
 *   cwd: '/home/user/project',
 *   command: 'claude',
 *   args: [],
 * });
 *
 * // Query all running runtimes
 * bus.emit(NativeSessionSupervisorSubjects.status, {});
 * ```
 */
export const NativeSessionSupervisorSubjects = NativeSessionSupervisorNamespace.subjects;
