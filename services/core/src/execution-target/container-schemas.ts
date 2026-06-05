import { z } from 'zod';

/**
 * One-shot stdin bootstrap payload written by the host before the container
 * entrypoint reads from stdin.
 *
 * All values are already-resolved plaintext — the host resolves any
 * `CredentialRef`s before serialising this payload. The container cannot
 * resolve refs over the bus because `credential.getChannelToken` is a
 * `localSubject` by design and is never routed to remote transports.
 *
 * Fields are all optional so the container can fall back to environment
 * variables when a field is absent or when stdin is not available.
 */
export const ContainerBootstrapConfigSchema = z.object({
  /**
   * HMAC secret for authenticating bus WebSocket connections.
   * Absent until Unit D wires HMAC auth end-to-end.
   */
  busAuthSecret: z.string().optional(),
  /**
   * Expected relay peer for E2E workflow-container connections.
   *
   * Relay containers use this public signing key to verify the host-side E2E
   * peer before sending the encrypted `workflow.getRunContext` request.
   */
  relayPeer: z
    .object({
      /** Expected peer identity id. */
      id: z.string().min(1),
      /** Base64URL raw ECDSA P-256 signing public key. */
      signingPublicKey: z.string().min(1),
    })
    .optional(),
  /**
   * E2E relay identity this container must claim.
   *
   * Workflow relay containers receive a per-execution signing key from the
   * host over stdin so the host can verify the `executionId` peer during the
   * encrypted relay handshake. Absent for direct-HMAC and session containers.
   */
  relayIdentity: z
    .object({
      /** Relay identity id the container must claim. */
      id: z.string().min(1),
      /** Base64URL raw ECDSA P-256 signing public key. */
      signingPublicKey: z.string().min(1),
      /** PKCS8 PEM ECDSA P-256 private key used by the container. */
      signingPrivateKeyPem: z.string().min(1),
    })
    .optional(),
  /**
   * Git access token for cloning private repositories inside the container.
   * Replaces the `MAKAIO_GIT_TOKEN` environment variable.
   */
  gitToken: z.string().optional(),
  /**
   * Credential environment variables resolved by the host.
   * Keys are environment variable names; values are plaintext credential values.
   * Applied onto `process.env` before the container runtime initialises.
   */
  credentialEnv: z.record(z.string(), z.string()).optional(),
  /**
   * Provider-level environment variables resolved by the host.
   * Applied onto `process.env` after `credentialEnv`.
   */
  providerEnv: z.record(z.string(), z.string()).optional(),
});
export type ContainerBootstrapConfig = z.infer<typeof ContainerBootstrapConfigSchema>;

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
  /**
   * Workflow execution identifier for workflow-execution containers.
   *
   * When provided the Docker service mints a per-execution HMAC secret and
   * injects it into `bootstrapConfig.busAuthSecret` so the container can
   * authenticate as `peer = { kind: 'workflow-execution', id: executionId }`.
   * Session-based subagent containers omit this field.
   */
  executionId: z.string().optional(),
  /** Adapter to load in container */
  adapter: z.string(),
  /** Container runtime type */
  runtime: ContainerRuntimeSchema.default('simple'),
  /** Override base image */
  image: z.string().optional(),
  /** Extra environment variables (non-secret config only — secrets travel via bootstrapConfig) */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Host-resolved bootstrap payload delivered to the container over stdin.
   * Carries plaintext secrets that must not appear in `docker inspect` output.
   * When present the DockerService writes this as a single JSON line to the
   * container's stdin before the entrypoint reads from it.
   */
  bootstrapConfig: ContainerBootstrapConfigSchema.optional(),
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
  /** Branch to check out inside the container. When omitted, the repo's default branch is cloned. */
  branch: z.string().optional(),
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
