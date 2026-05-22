/**
 * Synthesized MakaioExtension factory for detached extensions.
 *
 * Bridges the standard extension loading path to process-based execution
 * modes. The returned package satisfies {@link MakaioExtension} so the
 * ExtensionCoordinator manages it identically to embedded extensions.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension, NodeExtensionContext, ExtensionServiceLifecycle } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { descriptorToBasePackage } from './descriptor-to-package.js';
import type { DetachedDescriptor } from '@makaio/contracts/extension';
import type { StdioServerTransport } from '@makaio/bus-transport-stdio';
import { createProcessLifecycle, type ProcessLifecycleHandle } from '@makaio/subprocess';
import type { McpClientBridgeHandle } from '@makaio/subsystem-mcp-http-server';
import { z } from 'zod';

const DetachedLifecycleContextSchema = z.object({
  dataDir: z.string().optional(),
  machineId: z.string().optional(),
  makaioHome: z.string().optional(),
  platform: z.string().optional(),
  username: z.string().optional(),
});

const DetachedLifecycleSchemas = {
  init: {
    request: z.object({
      config: z.unknown().optional(),
      context: DetachedLifecycleContextSchema.optional(),
    }),
    response: z.object({ ready: z.boolean() }),
  },
  ready: z
    .object({
      ready: z.boolean(),
      config: z.unknown().optional(),
      context: DetachedLifecycleContextSchema.optional(),
    })
    .passthrough(),
  destroy: {
    request: z.object({ reason: z.string().optional() }),
    response: z.object({ stopped: z.boolean() }),
  },
  stopped: z.object({ stopped: z.boolean() }).passthrough(),
};

type RuntimeNodeExtensionContext = NodeExtensionContext<IMakaioBus>;

/**
 * Register lifecycle protocol subjects for one detached extension.
 * @param ctx - Node extension context containing the host bus.
 * @param extensionName - Detached extension name.
 * @returns Lifecycle subject definitions scoped to the detached extension.
 */
function registerDetachedLifecycleSubjects(ctx: RuntimeNodeExtensionContext, extensionName: string) {
  return ctx.bus.registerNamespace(createBusNamespace(`extension.${extensionName}`, DetachedLifecycleSchemas)).subjects;
}

type DetachedLifecycleSubjects = ReturnType<typeof registerDetachedLifecycleSubjects>;

/**
 * Create a per-service lifecycle subject resolver.
 *
 * Namespace registration is idempotent at the bus layer, but each detached
 * service owns one lifecycle namespace for its whole init/destroy lifetime.
 * Caching that registration keeps both lifecycle phases on the same subject
 * objects and avoids duplicate registerNamespace calls in tests and hosts.
 * @param ctx - Node extension context containing the host bus.
 * @param extensionName - Detached extension name.
 * @returns Function that returns cached lifecycle subjects.
 */
function createDetachedLifecycleSubjectResolver(
  ctx: RuntimeNodeExtensionContext,
  extensionName: string,
): () => DetachedLifecycleSubjects {
  let subjects: DetachedLifecycleSubjects | undefined;
  return () => {
    subjects ??= registerDetachedLifecycleSubjects(ctx, extensionName);
    return subjects;
  };
}

/**
 * Build the serializable runtime context sent to detached children.
 * @param ctx - Full host context.
 * @returns Detached child lifecycle context payload.
 */
function buildDetachedLifecycleContext(
  ctx: RuntimeNodeExtensionContext,
): z.infer<typeof DetachedLifecycleContextSchema> {
  return {
    dataDir: ctx.dataDir,
    machineId: ctx.machineId,
    makaioHome: ctx.makaioHome,
    platform: ctx.platform,
    username: ctx.username,
  };
}

// ---------------------------------------------------------------------------
// Per-transport service implementations
// ---------------------------------------------------------------------------

/**
 * Extension service managing a `bus-stdio` detached child process.
 *
 * Spawns the child process, establishes a `StdioServerTransport` for bus
 * communication, and registers it with the host bus. Both the transport
 * registration and the child process are torn down during destroy.
 */
class BusStdioExtensionService implements ExtensionServiceLifecycle {
  private readonly descriptor: DetachedDescriptor;
  private readonly ctx: RuntimeNodeExtensionContext;
  private readonly extensionPath: string;
  private readonly getLifecycleSubjects: () => DetachedLifecycleSubjects;
  /**
   * Stored after init() so destroy() can unregister and disconnect cleanly.
   * Null before init() and after destroy().
   */
  private transport: StdioServerTransport | null = null;
  private unregister: (() => void) | null = null;

  /**
   * @param descriptor - Detached extension descriptor providing spawn config.
   * @param ctx - Runtime context supplying the host bus.
   * @param extensionPath - Absolute path to the extension directory, used as the subprocess cwd.
   */
  public constructor(descriptor: DetachedDescriptor, ctx: RuntimeNodeExtensionContext, extensionPath: string) {
    this.descriptor = descriptor;
    this.ctx = ctx;
    this.extensionPath = extensionPath;
    this.getLifecycleSubjects = createDetachedLifecycleSubjectResolver(ctx, descriptor.name);
  }

  /**
   * Spawn the child process, register the transport with the host bus so
   * subscribe frames are captured immediately, then wait for the
   * subscribe-sync handshake to complete.
   *
   * Registering before awaiting `ready` ensures that subscribe frames sent
   * by the child during the handshake are not dropped.
   */
  public async init(): Promise<void> {
    const { StdioServerTransport } = await import('@makaio/bus-transport-stdio');
    const { transport: transportConfig } = this.descriptor;
    const lifecycleSubjects = this.getLifecycleSubjects();

    const transport = new StdioServerTransport({
      name: this.descriptor.name,
      spawn: {
        command: transportConfig.command,
        args: transportConfig.args,
        cwd: this.extensionPath,
        env: transportConfig.env,
        processName: this.descriptor.name,
      },
    });

    let unregister: (() => void) | null = null;
    try {
      const registration = this.ctx.bus.registerTransport(transport);
      unregister = registration.unregister;
      await transport.connect();
      await transport.ready;
      await registration.ready;

      this.transport = transport;
      this.unregister = unregister;

      await this.ctx.bus.request(
        lifecycleSubjects.init,
        {
          config: this.ctx.config ?? this.descriptor.config?.defaults,
          context: buildDetachedLifecycleContext(this.ctx),
        },
        { timeout: transportConfig.healthTimeoutMs },
      );
    } catch (error) {
      unregister?.();
      await transport.disconnect();
      this.transport = null;
      this.unregister = null;
      throw error;
    }
  }

  /**
   * Request graceful extension shutdown, unregister the transport, then
   * disconnect the child process.
   */
  public async destroy(): Promise<void> {
    if (this.transport !== null) {
      const lifecycleSubjects = this.getLifecycleSubjects();
      try {
        await this.ctx.bus.request(
          lifecycleSubjects.destroy,
          { reason: 'runtime-shutdown' },
          { timeout: this.descriptor.transport.shutdownTimeoutMs },
        );
      } catch (error) {
        console.warn(
          `[extensions] ${this.descriptor.name}: detached destroy lifecycle request did not complete before disconnect:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    this.unregister?.();
    this.unregister = null;
    await this.transport?.disconnect();
    this.transport = null;
  }
}

/**
 * Extension service managing a `bus-websocket` detached child process.
 *
 * Uses `ProcessLifecycle` to spawn the child and manage its lifecycle. The
 * process is responsible for connecting back to the host bus over WebSocket
 * independently.
 */
class ProcessLifecycleExtensionService implements ExtensionServiceLifecycle {
  private readonly descriptor: DetachedDescriptor;
  private readonly ctx: RuntimeNodeExtensionContext;
  private readonly extensionPath: string;
  private readonly getLifecycleSubjects: () => DetachedLifecycleSubjects;
  private lifecycle: ProcessLifecycleHandle | null = null;

  /**
   * @param descriptor - Detached extension descriptor providing spawn config.
   * @param ctx - Runtime context supplying bus URL and lifecycle RPC access.
   * @param extensionPath - Absolute path to the extension directory, used as the subprocess cwd.
   */
  public constructor(descriptor: DetachedDescriptor, ctx: RuntimeNodeExtensionContext, extensionPath: string) {
    this.descriptor = descriptor;
    this.ctx = ctx;
    this.extensionPath = extensionPath;
    this.getLifecycleSubjects = createDetachedLifecycleSubjectResolver(ctx, descriptor.name);
  }

  /**
   * Spawn the child process and wait for it to signal readiness.
   */
  public async init(): Promise<void> {
    const { transport: transportConfig } = this.descriptor;
    if (!this.ctx.busUrl) {
      throw new Error(
        `[extensions] ${this.descriptor.name}: bus-websocket transport requires NodeExtensionContext.busUrl`,
      );
    }
    const lifecycleSubjects = this.getLifecycleSubjects();

    this.lifecycle = createProcessLifecycle({
      spawn: {
        command: transportConfig.command,
        args: transportConfig.args,
        cwd: this.extensionPath,
        env: {
          ...transportConfig.env,
          MAKAIO_BUS_TRANSPORT: 'websocket',
          MAKAIO_BUS_URL: this.ctx.busUrl,
          MAKAIO_EXTENSION_NAME: this.descriptor.name,
        },
        processName: this.descriptor.name,
      },
      healthTimeoutMs: transportConfig.healthTimeoutMs,
      shutdownTimeoutMs: transportConfig.shutdownTimeoutMs,
      restartPolicy: 'restartPolicy' in transportConfig ? transportConfig.restartPolicy : undefined,
    });

    try {
      await this.lifecycle.start();
      await this.ctx.bus.request(
        lifecycleSubjects.init,
        {
          config: this.ctx.config ?? this.descriptor.config?.defaults,
          context: buildDetachedLifecycleContext(this.ctx),
        },
        { timeout: transportConfig.healthTimeoutMs },
      );
    } catch (error) {
      await this.lifecycle.stop();
      this.lifecycle = null;
      throw error;
    }
  }

  /**
   * Request extension shutdown over the bus, then stop the child process.
   */
  public async destroy(): Promise<void> {
    if (this.lifecycle !== null) {
      const lifecycleSubjects = this.getLifecycleSubjects();
      try {
        await this.ctx.bus.request(
          lifecycleSubjects.destroy,
          { reason: 'runtime-shutdown' },
          { timeout: this.descriptor.transport.shutdownTimeoutMs },
        );
      } catch (error) {
        console.warn(
          `[extensions] ${this.descriptor.name}: detached destroy lifecycle request did not complete before process stop:`,
          error instanceof Error ? error.message : error,
        );
      }
      await this.lifecycle.stop();
      this.lifecycle = null;
    }
  }
}

/**
 * Extension service managing an `mcp-stdio` detached child process.
 *
 * Spawns the child process as an MCP server and bridges it to the Makaio
 * bus via {@link startMcpClientBridge}. The bridge manages the MCP
 * client-side connection over stdin/stdout.
 */
class McpStdioExtensionService implements ExtensionServiceLifecycle {
  private readonly descriptor: DetachedDescriptor;
  private readonly ctx: RuntimeNodeExtensionContext;
  private readonly extensionPath: string;
  private bridge: McpClientBridgeHandle | null = null;

  /**
   * @param descriptor - Detached extension descriptor providing spawn config.
   * @param ctx - Runtime context supplying the host bus.
   * @param extensionPath - Absolute path to the extension directory, used as the subprocess cwd.
   */
  public constructor(descriptor: DetachedDescriptor, ctx: RuntimeNodeExtensionContext, extensionPath: string) {
    this.descriptor = descriptor;
    this.ctx = ctx;
    this.extensionPath = extensionPath;
  }

  /**
   * Spawn the MCP server subprocess and connect to it as an MCP client.
   * @see startMcpClientBridge
   */
  public async init(): Promise<void> {
    const { startMcpClientBridge } = await import('@makaio/subsystem-mcp-http-server');
    const { transport: transportConfig } = this.descriptor;

    this.bridge = await startMcpClientBridge({
      command: transportConfig.command,
      args: transportConfig.args,
      env: transportConfig.env,
      cwd: this.extensionPath,
      extensionName: this.descriptor.name,
      bus: this.ctx.bus,
    });
  }

  /**
   * Close the MCP client and terminate the subprocess.
   */
  public async destroy(): Promise<void> {
    if (this.bridge !== null) {
      await this.bridge.close();
      this.bridge = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a synthesized {@link MakaioExtension} for a detached extension.
 *
 * The returned package implements the standard `MakaioExtension` interface so
 * the `ExtensionCoordinator` can manage it identically to embedded extensions.
 *
 * Transport dispatch:
 * - `bus-stdio` — spawns child, establishes `StdioServerTransport`, registers
 *   it with the host bus. Child communicates via stdin/stdout.
 * - `bus-websocket` — spawns child via `ProcessLifecycle`; the child is
 *   expected to connect back to the host bus over WebSocket independently.
 * - `mcp-stdio` — spawns child as an MCP server and bridges it via
 *   {@link startMcpClientBridge}.
 * @param descriptor - Detached extension descriptor with transport config.
 * @param extensionPath - Absolute path to the extension directory, used as
 *   the working directory for the spawned child process.
 * @returns Synthesized `MakaioExtension` that manages the child process lifecycle.
 */
export function createDetachedExtensionPackage(
  descriptor: DetachedDescriptor,
  extensionPath: string,
): MakaioNodeExtension<IMakaioBus> {
  return {
    ...descriptorToBasePackage(descriptor),

    create(ctx: RuntimeNodeExtensionContext): ExtensionServiceLifecycle {
      if (descriptor.transport.type === 'bus-stdio') {
        return new BusStdioExtensionService(descriptor, ctx, extensionPath);
      }

      if (descriptor.transport.type === 'mcp-stdio') {
        return new McpStdioExtensionService(descriptor, ctx, extensionPath);
      }

      return new ProcessLifecycleExtensionService(descriptor, ctx, extensionPath);
    },
  };
}
