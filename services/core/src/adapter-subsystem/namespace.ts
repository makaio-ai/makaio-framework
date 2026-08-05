import { createBusNamespace } from '@makaio/core';
import { AdapterSubsystemSchemas } from './schemas.js';

/**
 * Bus namespace for adapter-subsystem subjects.
 */
export const AdapterSubsystemNamespace = createBusNamespace('adapterSubsystem', AdapterSubsystemSchemas);

/**
 * Pre-resolved adapter-subsystem subjects for direct import.
 */
export const AdapterSubsystemSubjects = AdapterSubsystemNamespace.subjects;

/**
 * Package name the adapter-subsystem service registers itself under.
 *
 * Declared beside the subjects rather than only in the subsystem package,
 * because a package whose service *requests* those subjects during startup has
 * to name the provider in its own `dependencies` — and it cannot import the
 * subsystem's token, which would invert the package layering. The subsystem
 * builds its token from this constant, so the two can never drift.
 */
export const ADAPTER_SUBSYSTEM_PACKAGE_NAME = 'adapter-subsystem';
