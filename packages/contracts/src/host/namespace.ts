import { MakaioBus } from '@makaio/bus-core';
import { HostSchemas } from './schemas.js';

/** Registered MakaioBus namespace for cross-cutting host shell RPCs. */
export const HostNamespace = MakaioBus.registerNamespace('host', HostSchemas);

/** Typed subject tree for the host namespace. */
export const HostSubjects = HostNamespace.subjects;
