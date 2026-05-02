import { z } from 'zod';

/**
 * Container runtime type.
 */
export const ContainerRuntimeSchema = z.enum(['simple', 'full']);
export type ContainerRuntime = z.infer<typeof ContainerRuntimeSchema>;

/**
 * Container state.
 */
export const ContainerStateSchema = z.enum(['created', 'running', 'stopped', 'destroyed']);
export type ContainerState = z.infer<typeof ContainerStateSchema>;

const SpawnRequestBase = z.object({
  /** Unique session identifier */
  sessionId: z.string(),
  /** Adapter to load in container */
  adapter: z.string(),
  /** Container runtime type */
  runtime: ContainerRuntimeSchema.default('simple'),
  /** Override base image */
  image: z.string().optional(),
  /** Extra environment variables */
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * Spawn request for container-local mode.
 */
export const ContainerLocalSpawnRequestSchema = SpawnRequestBase.extend({
  mode: z.literal('container-local'),
  /** Host path to git repository */
  repoPath: z.string(),
  /** Branch to fork from */
  baseBranch: z.string(),
  /** Branch to create */
  worktreeBranch: z.string().optional(),
});
export type ContainerLocalSpawnRequest = z.infer<typeof ContainerLocalSpawnRequestSchema>;

/**
 * Spawn request for container-isolated mode.
 */
export const ContainerIsolatedSpawnRequestSchema = SpawnRequestBase.extend({
  mode: z.literal('container-isolated'),
  /** Git remote URL to clone */
  repoUrl: z.string(),
  /** Branch to check out inside the container */
  branch: z.string(),
  /** Git authentication token for cloning */
  gitToken: z.string(),
  /**
   * Bus connectivity mode.
   * - 'host': ws://host.docker.internal
   * - 'relay': wss://relay.makaio.dev
   */
  busMode: z.enum(['host', 'relay']),
  /** Relay URL override for 'relay' mode */
  relayUrl: z.string().optional(),
});
export type ContainerIsolatedSpawnRequest = z.infer<typeof ContainerIsolatedSpawnRequestSchema>;

/**
 * Discriminated spawn request union.
 */
export const SpawnRequestSchema = z.discriminatedUnion('mode', [
  ContainerLocalSpawnRequestSchema,
  ContainerIsolatedSpawnRequestSchema,
]);
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/**
 * Spawn container response.
 */
export const SpawnResponseSchema = z.object({
  /** Docker container ID */
  containerId: z.string(),
  /** Host path to created worktree */
  worktreePath: z.string().optional(),
  /** Created branch name */
  worktreeBranch: z.string().optional(),
});
export type SpawnResponse = z.infer<typeof SpawnResponseSchema>;

/**
 * Stop container request.
 */
export const StopRequestSchema = z.object({
  /** Docker container ID */
  containerId: z.string(),
  /** Delete worktree branch on cleanup */
  deleteBranch: z.boolean().default(false),
});
export type StopRequest = z.infer<typeof StopRequestSchema>;

/**
 * Stop container response.
 */
export const StopResponseSchema = z.object({
  success: z.boolean(),
});
export type StopResponse = z.infer<typeof StopResponseSchema>;

/**
 * Container status request.
 */
export const StatusRequestSchema = z.object({
  /** Docker container ID */
  containerId: z.string(),
});
export type StatusRequest = z.infer<typeof StatusRequestSchema>;

/**
 * Container status response.
 */
export const StatusResponseSchema = z.object({
  state: ContainerStateSchema,
  sessionId: z.string(),
  worktreePath: z.string().optional(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/**
 * Container created event.
 */
export const ContainerCreatedSchema = z.object({
  containerId: z.string(),
  sessionId: z.string(),
  worktreePath: z.string().optional(),
});
export type ContainerCreated = z.infer<typeof ContainerCreatedSchema>;

/**
 * Container started event.
 */
export const ContainerStartedSchema = z.object({
  containerId: z.string(),
  sessionId: z.string(),
  worktreePath: z.string().optional(),
});
export type ContainerStarted = z.infer<typeof ContainerStartedSchema>;

/**
 * Container stopped event.
 */
export const ContainerStoppedSchema = z.object({
  containerId: z.string(),
  sessionId: z.string(),
  exitCode: z.number(),
});
export type ContainerStopped = z.infer<typeof ContainerStoppedSchema>;

/**
 * Container destroyed event.
 */
export const ContainerDestroyedSchema = z.object({
  containerId: z.string(),
  sessionId: z.string(),
});
export type ContainerDestroyed = z.infer<typeof ContainerDestroyedSchema>;
