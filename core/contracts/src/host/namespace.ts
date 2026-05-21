import { createBusNamespace } from '@makaio/core';
import { HostSchemas } from './schemas.js';

/** Bus namespace definition for cross-cutting host shell RPCs. */
export const HostNamespace = createBusNamespace('host', HostSchemas);

/** Typed subject tree for the host namespace. */
export const HostSubjects = HostNamespace.subjects;
