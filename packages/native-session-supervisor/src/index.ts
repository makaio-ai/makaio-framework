/**
 * \@makaio/native-session-supervisor
 *
 * Shared framework package that owns the supervised native process runtime
 * lifecycle: spawning, tracking, and querying processes managed by the
 * supervisor.
 *
 * ## Key exports
 * - {@link RuntimeRegistry} — in-memory + persistent registry for runtime metadata
 * - {@link SupervisorService} — service stub (fully implemented in Task 4)
 * - {@link SupervisorRuntimeStorageSubjects} — bus subjects for storage CRUD
 * - {@link SupervisorRuntimeStorageNamespace} — storage namespace with Drizzle extension
 * - {@link supervisorRuntimes} — Drizzle table schema
 * - {@link PtyRuntime} — PTY session lifecycle manager (spawn, I/O, buffering, cleanup)
 * - {@link createNodePtyBackend} — lazily loads the `node-pty` backend for Node.js hosts
 * - {@link NodeBridgeBackend} — bridge-process backend for Bun hosts
 *
 * ## Usage
 * ```typescript
 * import { nativeSessionSupervisorPackage } from '@makaio/native-session-supervisor/package';
 * ```
 * @packageDocumentation
 */

export { RuntimeRegistry } from './runtime-registry.js';
export { SupervisorService } from './supervisor-service.js';
export type { PtyRuntimeFactory, PtyRuntimeHandlers } from './supervisor-service.js';
export type { SupervisorRuntime, SupervisorRuntimeInit, SupervisorRuntimeUpdate } from './types.js';
export { SupervisorRuntimeStorageNamespace, SupervisorRuntimeStorageSubjects } from './storage/namespace.js';
export { supervisorRuntimes } from './storage/schema.js';
export type { SelectSupervisorRuntime, InsertSupervisorRuntime } from './storage/schema.js';
export { registerDrizzleSupervisorRuntimeStorage } from './storage/drizzle-handler.js';
export { runtimeToRow, rowToRuntime } from './storage/map-runtime.js';

// PTY runtime primitives
export { PtyRuntime } from './pty/pty-runtime.js';
export type { PtySpawnParams, PtyLogger } from './pty/pty-runtime.js';
export { OutputBuffer } from './pty/output-buffer.js';
export type { BufferReadResult } from './pty/output-buffer.js';
export type { NodePtyBackend } from './pty/node-pty-backend.js';
export { NodeBridgeBackend } from './pty/node-bridge-backend.js';
export type { IPtyBackend, IPtyProcess, IPtySpawnOptions, PtyExitEvent, PtyOutputEvent } from './pty/types.js';

/**
 * Create the Node.js native PTY backend without making Bun hosts evaluate the
 * `node-pty` module while selecting the bridge backend.
 * @returns A `node-pty` backed PTY backend.
 */
export async function createNodePtyBackend(): Promise<import('./pty/types.js').IPtyBackend> {
  const { NodePtyBackend } = await import('./pty/node-pty-backend.js');
  return new NodePtyBackend();
}
