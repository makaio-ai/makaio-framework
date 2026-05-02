import { MakaioBus } from '@makaio/bus-core';
import { CapabilitySchemas } from './schemas.js';

export const CapabilityNamespace = MakaioBus.registerNamespace('capability', CapabilitySchemas);

export const CapabilitySubjects = CapabilityNamespace.subjects;
