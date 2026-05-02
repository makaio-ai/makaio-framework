import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubsystemSchemas } from './schemas.js';

/**
 * Bus namespace for adapter-subsystem subjects.
 */
export const AdapterSubsystemNamespace = MakaioBus.registerNamespace('adapterSubsystem', AdapterSubsystemSchemas);

/**
 * Pre-resolved adapter-subsystem subjects for direct import.
 */
export const AdapterSubsystemSubjects = AdapterSubsystemNamespace.subjects;
