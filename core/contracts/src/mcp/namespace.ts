import { createBusNamespace } from '@makaio/core';
import { McpSchemas } from './schemas.js';

/** MCP domain namespace for server lifecycle, tool registry, and session resolution subjects. */
export const McpNamespace = createBusNamespace('mcp', McpSchemas);

/** Typed subject accessors for the MCP namespace. */
export const McpSubjects = McpNamespace.subjects;
