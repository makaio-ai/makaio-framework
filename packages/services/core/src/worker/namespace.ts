import { createBusNamespace } from '@makaio/core';
import { WorkerKernelSchemas } from './schemas.js';

/**
 * Worker namespace schemas.
 *
 * Split into two concerns:
 * - settings:worker.* - Definition CRUD (handled by SettingsService)
 * - worker.* - Runtime lifecycle (handled by WorkerService)
 */

export const WorkerKernelNamespace = createBusNamespace('worker', WorkerKernelSchemas);

export const WorkerSubjects = WorkerKernelNamespace.subjects;
