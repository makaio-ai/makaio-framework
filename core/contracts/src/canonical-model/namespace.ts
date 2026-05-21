import { createBusNamespace } from '@makaio/core';
import { CanonicalModelSchemas } from './schemas.js';

/** Bus namespace definition for framework canonical-model resolution. */
export const CanonicalModelNamespace = createBusNamespace('canonicalModel', CanonicalModelSchemas);

/** Typed subjects for canonical model bus operations. */
export const CanonicalModelSubjects = CanonicalModelNamespace.subjects;
