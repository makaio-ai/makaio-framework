import { createBusNamespace } from '@makaio/core';
import { AgentSchemas } from './schemas.js';

export const AgentNamespace = createBusNamespace('agent', AgentSchemas);

export const AgentSubjects = AgentNamespace.subjects;
