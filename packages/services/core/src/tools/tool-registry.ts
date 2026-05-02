// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 530 }] */
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { createMakaioContext } from '@makaio/core';
import type {
  AnyToolDefinition,
  FileAccessRuleProvider,
  ToolExecutionContext,
  ToolInfo,
  ToolResult,
  Toolset,
} from '@makaio/tools-core';
import { FILE_ACCESS_RULES_KEY, ToolErrorCodes, errorToToolResult, toolError } from '@makaio/tools-core';
import { z } from 'zod';
import { ToolSubjects } from '@makaio/contracts';
import { resolveAdapterIdentity, type EffectiveAdapterIdentity } from './adapter-identity.js';
import { getAllowedDirectoriesFromConstraints } from './context-constraints.js';
import { applyPolicyFilter } from './policy-filter.js';
import type {
  ExecuteOptions,
  ListToolsFilter,
  ToolRegistryOptions,
  ToolsetInfo,
  ToolsetPolicyProvider,
  ToolsWithToolsetsResult,
} from './types.js';

// Re-export types for external use
export type {
  ExecuteOptions,
  ListToolsFilter,
  ToolRegistryOptions,
  ToolsetInfo,
  ToolsetPolicy,
  ToolsetPolicyProvider,
  ToolsWithToolsetsResult,
} from './types.js';
/** Internal storage for registered tools with toolset association. */
interface RegisteredTool {
  tool: AnyToolDefinition;
  toolsetName: string;
}
/**
 * Generates a unique execution ID for tracking tool executions.
 * @returns Unique execution ID string
 */
function generateExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
/**
 * Central registry for tools and toolsets.
 * Manages registration, lookup, and execution with bus integration.
 * Emits lifecycle events (registered, started, completed, error) for observability.
 * Emits `registryChanged` with a monotonically increasing revision whenever the set of
 * registered toolsets changes, allowing consumers to invalidate stale tool lists.
 */
export class ToolRegistry {
  private readonly bus: IMakaioBus;
  private readonly toolsets = new Map<string, Toolset>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly cleanupHandlers: Array<() => void> = [];
  private readonly handlerPriority: number;
  private readonly policyProvider?: ToolsetPolicyProvider;
  private readonly fileAccessRuleProvider?: FileAccessRuleProvider;
  private revision = 0;
  /**
   * Creates a new ToolRegistry with optional configuration.
   * @param options - Registry configuration options
   */
  public constructor(options?: ToolRegistryOptions) {
    this.bus = options?.bus ?? MakaioBus;
    this.handlerPriority = options?.handlerPriority ?? 0;
    this.policyProvider = options?.policyProvider;
    this.fileAccessRuleProvider = options?.fileAccessRuleProvider;
    this.registerHandlers();
  }

  /** Registers RPC handlers for tool.list and tool.execute on the bus. */
  private registerHandlers(): void {
    // Handler for tool.list requests
    const listUnsubscribe = this.bus.on(
      ToolSubjects.list,
      async (context) => {
        const { toolsetName, adapterId, adapterName } = context.payload;
        const { tools, toolsets } = await this.listToolsWithToolsets({ toolsetName, adapterId, adapterName });
        context.setResult({ tools, toolsets });
      },
      { priority: this.handlerPriority },
    );
    this.cleanupHandlers.push(listUnsubscribe);

    // Handler for tool.execute requests
    const executeUnsubscribe = this.bus.on(
      ToolSubjects.execute,
      async (context) => {
        const { toolName, input, adapterId, adapterName, contextOverrides } = context.payload;

        const result = await this.execute(toolName, input, {
          contextOverrides,
          adapterId,
          adapterName,
        });
        context.setResult(result);
      },
      { priority: this.handlerPriority },
    );
    this.cleanupHandlers.push(executeUnsubscribe);
  }

  /**
   * Registers a toolset. All tools are indexed by name. Emits `tool.registered` event.
   * @param toolset - Toolset to register
   */
  public async register(toolset: Toolset): Promise<void> {
    if (this.toolsets.has(toolset.metadata.name)) {
      throw new Error(`Toolset '${toolset.metadata.name}' is already registered`);
    }

    const toolNames: string[] = [];
    const registrations: RegisteredTool[] = [];
    // Object.entries guarantees unique keys; cross-toolset collisions are caught by this.tools.has below.
    for (const [, tool] of Object.entries(toolset.tools)) {
      const toolName = tool.metadata.name;
      if (this.tools.has(toolName)) {
        throw new Error(
          `Tool '${toolName}' is already registered (from toolset '${this.tools.get(toolName)!.toolsetName}')`,
        );
      }
      registrations.push({
        tool,
        toolsetName: toolset.metadata.name,
      });
      toolNames.push(toolName);
    }

    this.toolsets.set(toolset.metadata.name, toolset);
    for (let index = 0; index < registrations.length; index += 1) {
      this.tools.set(toolNames[index], registrations[index]);
    }

    await this.emitRegistryChanged('toolset-registered', toolset.metadata.name).catch((error) =>
      console.warn(
        `[ToolRegistry] Failed to emit ${ToolSubjects.registryChanged.subject} for '${toolset.metadata.name}':`,
        error,
      ),
    );
    await this.bus
      .emit(ToolSubjects.registered, {
        toolsetName: toolset.metadata.name,
        toolsetVersion: toolset.metadata.version,
        toolNames,
      })
      .catch((error) =>
        console.warn(
          `[ToolRegistry] Failed to emit ${ToolSubjects.registered.subject} for '${toolset.metadata.name}':`,
          error,
        ),
      );
  }

  /**
   * Deregisters a toolset and all its tools. Emits `tool.registryChanged` event.
   * @param toolsetName - Name of the toolset to deregister
   * @throws Error if the toolset is not registered
   */
  public async deregister(toolsetName: string): Promise<void> {
    const toolset = this.toolsets.get(toolsetName);
    if (!toolset) {
      throw new Error(`Toolset '${toolsetName}' is not registered`);
    }
    for (const tool of Object.values(toolset.tools)) {
      this.tools.delete(tool.metadata.name);
    }
    this.toolsets.delete(toolsetName);
    await this.emitRegistryChanged('toolset-unregistered', toolsetName).catch((error) =>
      console.warn(
        `[ToolRegistry] Failed to emit ${ToolSubjects.registryChanged.subject} for '${toolsetName}':`,
        error,
      ),
    );
  }

  /**
   * Emit a monotonic registryChanged event for toolset lifecycle updates.
   * @param reason - Change reason enum.
   * @param toolsetName - Affected toolset.
   */
  private async emitRegistryChanged(
    reason: 'toolset-registered' | 'toolset-unregistered' | 'plugin-loaded' | 'plugin-unloaded',
    toolsetName: string,
  ): Promise<void> {
    this.revision += 1;
    await this.bus.emit(ToolSubjects.registryChanged, {
      revision: this.revision,
      reason,
      toolsetName,
    });
  }

  /**
   * Executes a tool by name with the given input.
   *
   * Validates input against the tool's schema, enforces policy, executes the tool,
   * and emits lifecycle events (started, completed/error). Constraints are enriched
   * with file access rules before the tool receives its context.
   * @param toolName - Name of the tool to execute
   * @param input - Input data (validated against tool's inputSchema)
   * @param options - Optional execution options (context overrides, adapter identity)
   * @returns Tool execution result (success with data or failure with error)
   */
  public async execute(toolName: string, input: unknown, options?: ExecuteOptions): Promise<ToolResult<unknown>> {
    const registered = this.tools.get(toolName);

    if (!registered) {
      return toolError(ToolErrorCodes.TOOL_NOT_FOUND, `Tool '${toolName}' not found`);
    }

    const adapterIdentity = resolveAdapterIdentity(options);
    if (!adapterIdentity.success) {
      return adapterIdentity;
    }

    const { tool, toolsetName } = registered;

    // Enforce policy if provider is configured
    const policyError = await this.checkPolicy(
      toolsetName,
      toolName,
      adapterIdentity.data.adapterId,
      adapterIdentity.data.adapterName,
    );
    if (policyError) {
      return policyError;
    }

    const executionId = generateExecutionId();
    const startTime = Date.now();

    // Emit started event
    await this.bus.emit(ToolSubjects.started, {
      toolName,
      toolsetName,
      executionId,
      timestamp: startTime,
    });

    try {
      // Validate input
      const parseResult = tool.inputSchema.safeParse(input);
      if (!parseResult.success) {
        const error = toolError(ToolErrorCodes.VALIDATION_FAILED, 'Input validation failed', {
          issues: parseResult.error.issues,
        });

        await this.bus.emit(ToolSubjects.error, {
          toolName,
          toolsetName,
          executionId,
          timestamp: Date.now(),
          error: error.error,
        });

        return error;
      }

      const context = await this.buildExecutionContext(options, adapterIdentity.data);
      const result = await tool.execute(parseResult.data, context);

      if (result.success) {
        await this.bus.emit(ToolSubjects.completed, {
          toolName,
          toolsetName,
          executionId,
          timestamp: Date.now(),
          durationMs: Date.now() - startTime,
        });
      } else {
        await this.bus.emit(ToolSubjects.error, {
          toolName,
          toolsetName,
          executionId,
          timestamp: Date.now(),
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      const toolResult = errorToToolResult(error);

      await this.bus.emit(ToolSubjects.error, {
        toolName,
        toolsetName,
        executionId,
        timestamp: Date.now(),
        error: toolResult.error,
      });

      return toolResult;
    }
  }

  /**
   * Builds a ToolExecutionContext from execute options, enriching constraints
   * with file access rules when a provider is configured.
   * @param options - Execution options with optional context overrides
   * @param effectiveAdapterIdentity - Canonical adapter identity for this execution
   * @returns Fully populated ToolExecutionContext
   */
  private async buildExecutionContext(
    options: ExecuteOptions | undefined,
    effectiveAdapterIdentity: EffectiveAdapterIdentity,
  ): Promise<ToolExecutionContext> {
    let enrichedConstraints = options?.contextOverrides?.constraints;
    if (this.fileAccessRuleProvider) {
      const cwd = options?.contextOverrides?.cwd ?? process.cwd();
      const allowedDirs = getAllowedDirectoriesFromConstraints(enrichedConstraints);
      const rules = await this.fileAccessRuleProvider(cwd, allowedDirs);
      enrichedConstraints = { ...enrichedConstraints, [FILE_ACCESS_RULES_KEY]: rules };
    }

    // Cast bus to BusLike — IMakaioBus implements BusLike methods but with stricter types
    const baseContext = createMakaioContext({ ...options?.contextOverrides, constraints: enrichedConstraints });
    const overrides = options?.contextOverrides as Partial<ToolExecutionContext> | undefined;
    return {
      ...baseContext,
      bus: this.bus as ToolExecutionContext['bus'],
      sessionId: overrides?.sessionId,
      agentId: overrides?.agentId,
      adapterId: effectiveAdapterIdentity.adapterId,
      adapterName: effectiveAdapterIdentity.adapterName,
      turnId: overrides?.turnId,
      turnContext: overrides?.turnContext,
      toolCallId: overrides?.toolCallId,
    };
  }

  /**
   * Check policy for tool execution. Returns ToolFailure if denied, null if allowed.
   * @param toolsetName - Toolset name for policy lookup
   * @param toolName - Tool name to check
   * @param adapterId - Adapter ID for allowedAdapters check
   * @param adapterName - Adapter name for allowedAdapters check
   * @returns ToolFailure if denied, null if allowed
   */
  private async checkPolicy(
    toolsetName: string,
    toolName: string,
    adapterId?: string,
    adapterName?: string,
  ): Promise<ToolResult<never> | null> {
    if (!this.policyProvider) {
      return null; // No policy provider = allow all
    }

    const policy = await this.policyProvider(toolsetName);
    if (!policy) {
      return null; // No policy for this toolset = allow all
    }

    // Check disabledTools
    if (policy.disabledTools?.includes(toolName)) {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, `Tool '${toolName}' is disabled`, {
        toolsetName,
        toolName,
      });
    }

    // Check allowedAdapters (only if list is non-empty)
    if (policy.allowedAdapters && policy.allowedAdapters.length > 0) {
      const adapterIdentifier = adapterName ?? adapterId;
      if (!adapterIdentifier || !policy.allowedAdapters.includes(adapterIdentifier)) {
        return toolError(ToolErrorCodes.PERMISSION_DENIED, `Adapter not allowed for toolset '${toolsetName}'`, {
          toolsetName,
          adapterId,
          adapterName,
          allowedAdapters: policy.allowedAdapters,
        });
      }
    }

    return null;
  }

  /**
   * Lists all registered tools with optional filtering.
   * @param filter - Optional filter criteria
   * @returns Array of tool information
   */
  public listTools(filter?: ListToolsFilter): ToolInfo[] {
    const tools: ToolInfo[] = [];

    for (const [, registered] of this.tools) {
      // Apply toolset filter if specified
      if (filter?.toolsetName && registered.toolsetName !== filter.toolsetName) {
        continue;
      }

      // Convert Zod schema to JSON Schema for format conversion
      const jsonSchema = z.toJSONSchema(registered.tool.inputSchema);

      // Remove $schema property for cleaner output
      const { $schema: _, ...inputSchema } = jsonSchema as Record<string, unknown>;

      tools.push({
        name: registered.tool.metadata.name,
        description: registered.tool.metadata.description,
        toolsetName: registered.toolsetName,
        annotations: registered.tool.metadata.annotations,
        inputSchema,
      });
    }

    return tools;
  }

  /**
   * Lists all registered toolsets with metadata including configSchema as JSON Schema.
   * @returns Array of toolset information
   */
  public listToolsets(): ToolsetInfo[] {
    const toolsets: ToolsetInfo[] = [];

    for (const [, toolset] of this.toolsets) {
      const info: ToolsetInfo = {
        name: toolset.metadata.name,
        description: toolset.metadata.description,
        version: toolset.metadata.version,
        toolCount: Object.keys(toolset.tools).length,
      };

      if (toolset.configSchema) {
        const jsonSchema = z.toJSONSchema(toolset.configSchema);
        const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;
        info.configSchema = schema;
      }

      toolsets.push(info);
    }

    return toolsets;
  }

  /**
   * Lists tools and toolsets with optional filtering. Applies policy filtering when adapterName is provided.
   * @param filter - Optional filter criteria
   * @returns Object containing tools array and toolsets array
   */
  public async listToolsWithToolsets(filter?: ListToolsFilter): Promise<ToolsWithToolsetsResult> {
    const tools = this.listTools(filter);
    const allToolsets = this.listToolsets();

    // Apply toolset name filter
    const toolsets = filter?.toolsetName
      ? allToolsets.filter((toolset) => toolset.name === filter.toolsetName)
      : allToolsets;

    // Apply policy filtering (adapterName preferred over adapterId)
    const adapterIdentifier = filter?.adapterName ?? filter?.adapterId;
    if (this.policyProvider && adapterIdentifier) {
      const { filteredTools, filteredToolsets } = await applyPolicyFilter(
        tools,
        toolsets,
        adapterIdentifier,
        this.policyProvider,
      );
      return { tools: filteredTools, toolsets: filteredToolsets };
    }

    return { tools, toolsets };
  }
  /**
   * Gets a tool definition by name.
   * @param name - Tool name to look up
   * @returns Tool definition or undefined if not found
   */
  public getTool(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }
  /**
   * Gets a toolset by name.
   * @param name - Toolset name to look up
   * @returns Toolset or undefined if not found
   */
  public getToolset(name: string): Toolset | undefined {
    return this.toolsets.get(name);
  }
  /** Cleans up registry resources. Unsubscribes all bus handlers. */
  public dispose(): void {
    for (const cleanup of this.cleanupHandlers) {
      cleanup();
    }
    this.cleanupHandlers.length = 0;
  }

  /**
   * Destroy this registry — alias for {@link dispose} to satisfy the package
   * service lifecycle contract.
   */
  public destroy(): void {
    this.dispose();
  }
}
