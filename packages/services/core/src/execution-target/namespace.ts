import { createBusNamespace } from '@makaio/core';
import { ExecutionTargetSchemas } from './schemas.js';

/** Execution-target bus namespace — manages container lifecycle and spawn coordination. */
export const ExecutionTargetNamespace = createBusNamespace('execution-target', ExecutionTargetSchemas);

/**
 * Typed subjects for all execution-target bus operations.
 */
export const ExecutionTargetSubjects = ExecutionTargetNamespace.subjects;
