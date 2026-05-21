import { createBusNamespace } from '@makaio/core';
import { CapabilitySchemas } from './schemas.js';

export const CapabilityNamespace = createBusNamespace('capability', CapabilitySchemas);

export const CapabilitySubjects = CapabilityNamespace.subjects;
