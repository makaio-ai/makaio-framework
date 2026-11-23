/**
 * Synthesized MakaioExtension factory for detached extensions.
 *
 * Bridges the standard extension loading path to process-based execution
 * modes. The returned package satisfies {@link MakaioExtension} so the
 * ExtensionCoordinator manages it identically to embedded extensions.
 * @packageDocumentation
 */

import { DEFAULT_REQUEST_TIMEOUT_MS, type IMakaioBus } from '@makaio/bus-core';
import type {
  CallContext,
  ExtensionInitOptions,
  MakaioNodeExtension,
  NodeExtensionContext,
  ExtensionServiceLifecycle,
} from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { descriptorToBasePackage } from './descriptor-to-package.js';
import type { DetachedDescriptor } from '@makaio/contracts/extension';
import type { StdioServerTransport } from '@makaio/bus-transport-stdio';
import {
  createProcessLifecycle,
  describeTransportEnd,
  processStopBudgetMs,
  type ProcessLifecycleHandle,
  type ProcessRunOutcome,
  type ProcessStopTiming,
} from '@makaio/subprocess';
import type { McpClientBridgeHandle } from '@makaio/subsystem-mcp-http-server';
import { abortableWait } from '@makaio/utils';
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
 * The kernel retains the claim for the lifetime of the extension entry.
 * @param ctx - Context of the represented extension.
 * @param extensionName - Detached extension name.
 * @returns Lifecycle subject definitions scoped to the detached extension.
 */
function registerDetachedLifecycleSubjects(ctx: RuntimeNodeExtensionContext, extensionName: string) {
  const namespace = createBusNamespace(`extension.${extensionName}`, DetachedLifecycleSchemas);
  ctx.namespaces.lease(namespace);
  return namespace.subjects;
}

type DetachedLifecycleSubjects = ReturnType<typeof registerDetachedLifecycleSubjects>;

/**
 * Create a per-service lifecycle subject resolver.
 *
 * Namespace registration is idempotent at the bus layer, but each detached
 * service owns one lifecycle namespace for its whole init/destroy lifetime.
 * Caching that registration keeps both lifecycle phases on the same subject
 * objects and avoids duplicate lease requests.
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

/**
 * The limits the stop of one detached extension runs under. The services
 * enforce exactly these values and report their sum as their stop window, so
 * what the host waits for and what the stop is held to cannot drift apart.
 */
interface DetachedStopLimits {
  /** Time the extension has to answer its lifecycle `destroy` request. */
  readonly destroyRequestTimeoutMs: number;
  /** Stop timing of the child: `shutdownTimeoutMs` is its graceful stage; the rest are the subprocess defaults. */
  readonly stopTiming: ProcessStopTiming;
  /** Longest the whole stop takes: the request, then the bounded stop of the child, which follow one another. */
  readonly budgetMs: number;
}

/**
 * Resolve the stop limits of a detached extension from its descriptor.
 * @param descriptor - Detached extension descriptor.
 * @returns The limits the extension's stop is held to.
 */
function resolveDetachedStopLimits(descriptor: DetachedDescriptor): DetachedStopLimits {
  const { shutdownTimeoutMs } = descriptor.transport;
  const stopTiming: ProcessStopTiming = { killGraceMs: shutdownTimeoutMs };
  const destroyRequestTimeoutMs = shutdownTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return { destroyRequestTimeoutMs, stopTiming, budgetMs: destroyRequestTimeoutMs + processStopBudgetMs(stopTiming) };
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
  public readonly stopBudgetMs: number;
  private readonly stopLimits: DetachedStopLimits;
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
    this.stopLimits = resolveDetachedStopLimits(descriptor);
    this.stopBudgetMs = this.stopLimits.budgetMs;
  }

  /**
   * Spawn the child process, register the transport with the host bus so
   * subscribe frames are captured immediately, then wait for the
   * subscribe-sync handshake to complete.
   *
   * Registering before awaiting `ready` ensures that subscribe frames sent
   * by the child during the handshake are not dropped.
   *
   * The handshake waits and the `init` request end when the host cancels the
   * start (`options.signal`); the failure path then stops the child like any
   * other failed start.
   * @param options - Start options; see {@link ExtensionInitOptions}.
   */
  public async init(options: ExtensionInitOptions = {}): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
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
      // The descriptor's stop window bounds the transport's stop, not only the destroy request.
      stopTiming: this.stopLimits.stopTiming,
    });

    let unregister: (() => void) | null = null;
    try {
      const registration = this.ctx.bus.registerTransport(transport);
      unregister = registration.unregister;
      await transport.connect();
      await abortableWait(transport.ready, signal);
      await abortableWait(registration.ready, signal);

      this.transport = transport;
      this.unregister = unregister;

      // ORIGIN: Host startup initializes the stdio child after the handshake.
      await this.ctx.bus.request(
        this.ctx.bus.own('start'),
        lifecycleSubjects.init,
        {
          config: this.ctx.config ?? this.descriptor.config?.defaults,
          context: buildDetachedLifecycleContext(this.ctx),
        },
        { timeout: transportConfig.healthTimeoutMs, signal },
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
        // ORIGIN: Host teardown requests graceful shutdown of the stdio child.
        await this.ctx.bus.request(
          this.ctx.bus.own('stop'),
          lifecycleSubjects.destroy,
          { reason: 'runtime-shutdown' },
          { timeout: this.stopLimits.destroyRequestTimeoutMs },
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
 * independently. Starting an extension has two phases: stdout readiness, then
 * the host's `init` request with config and context. Every generation the
 * restart policy starts goes through both, so a restarted child is initialised
 * like the first one.
 *
 * The child runs in a process group of its own, so a terminal's Ctrl-C or hangup
 * aimed at the host does not reach it, and its stdout carries only readiness. A
 * host that dies without stopping it leaves it running until it reacts on its
 * own: a detached child must exit when its stdin closes or its bus connection
 * is lost for good.
 */
class ProcessLifecycleExtensionService implements ExtensionServiceLifecycle {
  public readonly stopBudgetMs: number;
  private readonly stopLimits: DetachedStopLimits;
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
    this.stopLimits = resolveDetachedStopLimits(descriptor);
    this.stopBudgetMs = this.stopLimits.budgetMs;
  }

  /**
   * Spawn the child process and wait for it to signal readiness, then send the
   * `init` request. Both waits end when the host cancels the start
   * (`options.signal`): the lifecycle is stopped through its own `stop()`, which
   * also stops the child.
   * @param options - Start options; see {@link ExtensionInitOptions}.
   */
  public async init(options: ExtensionInitOptions = {}): Promise<void> {
    const { signal } = options;
    const { transport: transportConfig } = this.descriptor;
    if (!this.ctx.busUrl) {
      throw new Error(
        `[extensions] ${this.descriptor.name}: bus-websocket transport requires NodeExtensionContext.busUrl`,
      );
    }
    // Register the lifecycle subjects before the child can reach the bus.
    this.getLifecycleSubjects();

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
      stopTiming: this.stopLimits.stopTiming,
      restartPolicy: 'restartPolicy' in transportConfig ? transportConfig.restartPolicy : undefined,
      onReady: () => this.initializeRestartedGeneration(),
      onExit: (outcome) => this.reportUnrequestedEnd(outcome),
    });

    try {
      await this.lifecycle.start({ signal });
      // ORIGIN: Host startup initializes the first WebSocket child generation.
      await this.requestInit(this.ctx.bus.own('start'), signal);
    } catch (error) {
      await this.lifecycle.stop();
      this.lifecycle = null;
      throw error;
    }
  }

  /**
   * Send the host's lifecycle `init` request to the current generation.
   * @param call - Context for the startup or automatic restart.
   * @param signal - Cancels the wait for the reply.
   * @returns Promise that settles with the request.
   */
  private async requestInit(call: CallContext, signal?: AbortSignal): Promise<void> {
    await this.ctx.bus.request(
      call,
      this.getLifecycleSubjects().init,
      {
        config: this.ctx.config ?? this.descriptor.config?.defaults,
        context: buildDetachedLifecycleContext(this.ctx),
      },
      { timeout: this.descriptor.transport.healthTimeoutMs, signal },
    );
  }

  /**
   * Initialise a generation that an automatic restart made ready. The first
   * generation is initialised by `init()` once `start()` resolved; any later one
   * comes from the restart policy and would otherwise run uninitialised.
   *
   * A failed `init` follows the contract of the first start: the child never
   * received its configuration, so it is stopped rather than left running
   * uninitialised, and the failure is reported. The lifecycle has no seam that
   * lets its owner fail a generation into the restart budget, so the service
   * ends `stopped` and no further restart follows; a fresh service start
   * (`init()`) is the way back. Only a generation that is still the current,
   * running one is stopped: when it already ended, the lifecycle's own end
   * handling and restart policy have the say, and a newer generation
   * initialises itself.
   */
  private initializeRestartedGeneration(): void {
    const lifecycle = this.lifecycle;
    if (lifecycle === null || lifecycle.generation <= 1) return;
    const { generation } = lifecycle;
    // ORIGIN: The restart policy starts a new generation independently of host startup.
    this.requestInit(this.ctx.bus.own('schedule')).catch(async (error: unknown) => {
      console.error(
        `[extensions] ${this.descriptor.name}: init of restarted generation ${generation} failed:`,
        error instanceof Error ? error.message : error,
      );
      if (this.lifecycle !== lifecycle || lifecycle.generation !== generation || lifecycle.state !== 'running') return;
      console.error(`[extensions] ${this.descriptor.name}: stopping uninitialised generation ${generation}`);
      await lifecycle.stop();
      if (this.lifecycle === lifecycle) this.lifecycle = null;
    });
  }

  /**
   * Log a run that ended without being stopped, whatever the restart policy
   * then did; a stop requested by `destroy()` or a failed `init()` is no news.
   * @param outcome - The lifecycle's report of the run's end.
   */
  private reportUnrequestedEnd(outcome: ProcessRunOutcome): void {
    if (outcome.end.cause === 'requested') return;
    console.warn(
      `[extensions] ${this.descriptor.name}: generation ${outcome.generation} ${describeTransportEnd(outcome.end)} (restart: ${outcome.restart.kind})`,
    );
  }

  /**
   * Request extension shutdown over the bus, then stop the child process.
   */
  public async destroy(): Promise<void> {
    if (this.lifecycle !== null) {
      const lifecycleSubjects = this.getLifecycleSubjects();
      try {
        // ORIGIN: Host teardown requests graceful shutdown of the WebSocket child.
        await this.ctx.bus.request(
          this.ctx.bus.own('stop'),
          lifecycleSubjects.destroy,
          { reason: 'runtime-shutdown' },
          { timeout: this.stopLimits.destroyRequestTimeoutMs },
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
   * Spawn the MCP server subprocess and connect to it as an MCP client. The
   * handshake and the first tool listing end when the host cancels the start
   * (`options.signal`); the bridge then closes the subprocess like on any other
   * failed start.
   * @param options - Start options; see {@link ExtensionInitOptions}.
   * @see startMcpClientBridge
   */
  public async init(options: ExtensionInitOptions = {}): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
    const { startMcpClientBridge } = await import('@makaio/subsystem-mcp-http-server');
    const { transport: transportConfig } = this.descriptor;

    // ORIGIN: Starting the detached extension opens its MCP client bridge.
    this.bridge = await startMcpClientBridge(this.ctx.bus.own('start'), {
      command: transportConfig.command,
      args: transportConfig.args,
      env: transportConfig.env,
      cwd: this.extensionPath,
      extensionName: this.descriptor.name,
      bus: this.ctx.bus,
      signal,
    });
  }

  /**
   * Close the MCP client and terminate the subprocess.
   */
  public async destroy(): Promise<void> {
    if (this.bridge !== null) {
      // ORIGIN: Stopping the detached extension closes its MCP client bridge.
      await this.bridge.close(this.ctx.bus.own('stop'));
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
