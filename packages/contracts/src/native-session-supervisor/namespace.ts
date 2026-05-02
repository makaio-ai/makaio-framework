/**
 * Native Session Supervisor namespace registration.
 *
 * Registers the global `native-session-supervisor.*` namespace on the
 * MakaioBus, providing typed subjects for launching, attaching to, stopping,
 * and querying supervised native process runtimes.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { NativeSessionSupervisorSchemas } from './schemas.js';

/**
 * MakaioBus namespace registered under the `native-session-supervisor` prefix.
 */
export const NativeSessionSupervisorNamespace = MakaioBus.registerNamespace(
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
