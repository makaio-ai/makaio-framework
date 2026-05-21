import { createBusNamespace } from '@makaio/core';
import { ToolSchemas } from './schemas.js';

export const ToolNamespace = createBusNamespace('tool', ToolSchemas);

export const ToolSubjects = ToolNamespace.subjects;
