import { MakaioBus } from '@makaio/bus-core';
import { VCSPRSchemas } from './schemas.js';

/**
 * VCS:PR namespace for MakaioBus.
 *
 * Registers the enriched PR entity subjects. Uses 'vcs:pr' to signal
 * "same domain (VCS), higher abstraction level (aggregated PR entity)."
 */
export const VCSPRNamespace = MakaioBus.registerNamespace('vcs:pr', VCSPRSchemas);

/**
 * Type-safe subjects for enriched PR operations.
 */
export const VCSPRSubjects = VCSPRNamespace.subjects;
