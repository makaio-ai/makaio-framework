import { MakaioBus } from '@makaio/bus-core';
import { AdapterRuntimeSchemas } from './schemas.js';

/**
 * Runtime namespace for live adapter identity and lifecycle operations.
 */
export const AdapterRuntimeNamespace = MakaioBus.registerNamespace('adapterRuntime', AdapterRuntimeSchemas);

/**
 * Pre-resolved adapter runtime subjects for direct import.
 */
export const AdapterRuntimeSubjects = AdapterRuntimeNamespace.subjects;
