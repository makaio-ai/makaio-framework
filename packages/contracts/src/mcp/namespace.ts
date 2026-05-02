import { MakaioBus } from '@makaio/bus-core';
import { McpSchemas } from './schemas.js';

/** MCP domain namespace for server lifecycle, tool registry, and session resolution subjects. */
export const McpNamespace = MakaioBus.registerNamespace('mcp', McpSchemas);

/** Typed subject accessors for the MCP namespace. */
export const McpSubjects = McpNamespace.subjects;
