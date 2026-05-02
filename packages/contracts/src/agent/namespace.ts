import { MakaioBus } from '@makaio/bus-core';
import { AgentSchemas } from './schemas.js';

export const AgentNamespace = MakaioBus.registerNamespace('agent', AgentSchemas);

export const AgentSubjects = AgentNamespace.subjects;
