import { MakaioBus } from '@makaio/bus-core';
import { ToolSchemas } from './schemas.js';

export const ToolNamespace = MakaioBus.registerNamespace('tool', ToolSchemas);

export const ToolSubjects = ToolNamespace.subjects;
