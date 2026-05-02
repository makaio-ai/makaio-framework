import { MakaioBus } from '@makaio/bus-core';
import { CodebaseSchemas } from './schemas.js';

/**
 * Codebase namespace registration.
 */
export const CodebaseNamespace = MakaioBus.registerNamespace('codebase', CodebaseSchemas);

/**
 * Typed subjects for codebase operations.
 */
export const CodebaseSubjects = CodebaseNamespace.subjects;
