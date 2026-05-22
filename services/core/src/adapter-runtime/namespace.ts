import { createBusNamespace } from '@makaio/core';
import { AdapterRuntimeSchemas } from './schemas.js';

/**
 * Runtime namespace for live adapter identity and lifecycle operations.
 */
export const AdapterRuntimeNamespace = createBusNamespace('adapterRuntime', AdapterRuntimeSchemas);

/**
 * Pre-resolved adapter runtime subjects for direct import.
 */
export const AdapterRuntimeSubjects = AdapterRuntimeNamespace.subjects;
