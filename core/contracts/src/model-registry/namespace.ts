import { createBusNamespace } from '@makaio/core';
import { ModelRegistrySchemas } from './schemas.js';

/** Public model-registry namespace for SDK-safe model discovery subjects. */
export const ModelRegistryPublicNamespace = createBusNamespace('modelRegistry:public', ModelRegistrySchemas);

/** Typed subject accessors for SDK-safe model-registry operations. */
export const ModelRegistryPublicSubjects = ModelRegistryPublicNamespace.subjects;
