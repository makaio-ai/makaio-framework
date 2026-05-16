import { NoHandlerError, RequestError, type IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects, type ToolListItem } from '@makaio/contracts';
import { z } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { MakaioToolDefinition } from './types.js';

/**
 * Parameters for registering query-local SDK tool bridge handlers.
 */
interface RegisterSdkToolBridgeParams {
  /** Bus that receives tool.list and tool.execute requests. */
  bus: IMakaioBus;
  /** Session ID used to scope the synthetic SDK toolset. */
  sessionId: string;
  /** Working directory forwarded through execution context overrides. */
  cwd?: string;
  /** Environment forwarded through execution context overrides. */
  env?: Record<string, string>;
  /** SDK tool definitions passed to query options. */
  tools: readonly MakaioToolDefinition[];
}

type ToolListResult = {
  tools: ToolListItem[];
  toolsets: Array<{
    name: string;
    description: string;
    version: string;
    toolCount: number;
    configSchema?: Record<string, unknown>;
  }>;
};

const SDK_TOOL_PRIORITY = 100;

const isNoLowerToolHandler = (error: unknown, subject: string): boolean => {
  if (error instanceof NoHandlerError) return error.subject === subject;
  if (error instanceof RequestError && error.cause instanceof NoHandlerError) {
    return error.cause.subject === subject;
  }
  return false;
};

const toJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: 'none' });
  const { $schema: _ignored, definitions: _definitions, ...withoutMetaSchema } = jsonSchema as Record<string, unknown>;
  return withoutMetaSchema;
};

const createToolList = (toolsetName: string, tools: readonly MakaioToolDefinition[]): ToolListResult => ({
  tools: tools.map((definition) => ({
    name: definition.name,
    description: definition.description,
    annotations: definition.annotations,
    toolsetName,
    inputSchema: toJsonSchema(definition.inputSchema),
  })),
  toolsets: [
    {
      name: toolsetName,
      description: 'Agent SDK query-local tools',
      version: '0.0.0',
      toolCount: tools.length,
    },
  ],
});

const mergeToolLists = (base: ToolListResult | undefined, local: ToolListResult): ToolListResult => ({
  tools: [...(base?.tools ?? []), ...local.tools],
  toolsets: [...(base?.toolsets ?? []), ...local.toolsets],
});

const toolError = (code: string, message: string, details?: unknown) => ({
  success: false as const,
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

/**
 * Register query-local SDK tools on the Makaio tool bus.
 * @param params - Bus, session identity, execution context, and tool definitions.
 * @returns Cleanup callback that removes both bus handlers.
 */
export function registerSdkToolBridge(params: RegisterSdkToolBridgeParams): () => void {
  const { bus, sessionId, cwd, env, tools } = params;
  const toolsetName = `agent-sdk:${sessionId}`;
  const toolsByName = new Map(tools.map((definition) => [definition.name, definition]));

  const cleanupList = bus.on(
    ToolSubjects.list,
    async (ctx) => {
      const local = createToolList(toolsetName, tools);
      try {
        await ctx.next();
      } catch (error) {
        if (!isNoLowerToolHandler(error, ToolSubjects.list.subject)) throw error;
      }
      ctx.setResult(mergeToolLists(ctx.result as ToolListResult | undefined, local));
    },
    { priority: SDK_TOOL_PRIORITY },
  );

  const cleanupExecute = bus.on(
    ToolSubjects.execute,
    async (ctx) => {
      const definition = toolsByName.get(ctx.payload.toolName);
      if (definition === undefined) {
        await ctx.next();
        return;
      }

      const parseResult = definition.inputSchema.safeParse(ctx.payload.input);
      if (!parseResult.success) {
        ctx.setResult(toolError('SDK_TOOL_VALIDATION_FAILED', 'Input validation failed', parseResult.error.issues));
        return;
      }

      try {
        // MakaioToolDefinition intentionally erases tool()'s generic input
        // type so heterogeneous tools can share one options array. safeParse()
        // above revalidates the payload against this tool's stored schema
        // before the public Record-shaped handler boundary is crossed.
        const data = await definition.handler(parseResult.data as Record<string, unknown>);
        ctx.setResult({ success: true, data });
      } catch (error) {
        ctx.setResult(
          toolError('SDK_TOOL_ERROR', error instanceof Error ? error.message : String(error), {
            cwd,
            env,
          }),
        );
      }
    },
    { priority: SDK_TOOL_PRIORITY },
  );

  return () => {
    cleanupList();
    cleanupExecute();
  };
}
