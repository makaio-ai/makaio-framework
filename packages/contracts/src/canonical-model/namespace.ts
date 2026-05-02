import { MakaioBus } from '@makaio/bus-core';
import { CanonicalModelSchemas } from './schemas.js';

/** Registered bus namespace for framework canonical-model resolution. */
export const CanonicalModelNamespace = MakaioBus.registerNamespace('canonicalModel', CanonicalModelSchemas);

/** Typed subjects for canonical model bus operations. */
export const CanonicalModelSubjects = CanonicalModelNamespace.subjects;
