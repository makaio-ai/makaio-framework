import { createBusNamespace } from '@makaio/core';
import { CodebaseSchemas } from './schemas.js';

/**
 * Codebase namespace definition.
 */
export const CodebaseNamespace = createBusNamespace('codebase', CodebaseSchemas);

/**
 * Typed subjects for codebase operations.
 */
export const CodebaseSubjects = CodebaseNamespace.subjects;
