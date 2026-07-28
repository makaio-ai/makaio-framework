import { z } from 'zod';
import {
  AdapterAuthConstantSchema,
  AuthEnvironmentVariableNameSchema,
  AuthMethodRefSchema,
} from '@makaio/contracts/auth';

/** Dedicated bootstrap fields that must never fall back to ambient process env. */
export const CONTAINER_BOOTSTRAP_PRIVATE_ENV_VARS = ['MAKAIO_GIT_TOKEN', 'MAKAIO_BUS_AUTH_SECRET'] as const;

/** JSON-safe value delivered to an adapter-owned connector auth target. */
export const ContainerConnectorAuthValueSchema = AdapterAuthConstantSchema;
export type ContainerConnectorAuthValue = z.infer<typeof ContainerConnectorAuthValueSchema>;

/** Host-minted identity and exact package graph for one session container. */
export const ContainerSessionRuntimeBindingSchema = z
  .object({
    /** Host-minted identity published by the container runtime. */
    machineId: z.string().trim().min(1),
    /** Canonical package identities selected by the host runtime snapshot. */
    packageNames: z
      .array(z.string().trim().min(1))
      .min(1)
      .refine((packageNames) => new Set(packageNames).size === packageNames.length, {
        message: 'Session runtime package names must be unique.',
      })
      .readonly(),
  })
  .strict()
  .readonly();
export type ContainerSessionRuntimeBinding = z.infer<typeof ContainerSessionRuntimeBindingSchema>;

/**
 * Coordinates that bind one plaintext auth envelope to its intended container
 * config-factory invocation.
 *
 * Inferred/native auth is deliberately absent: native client state is not
 * portable into containers and must be rejected before the container is
 * spawned.
 */
export const ContainerAdapterAuthSelectorSchema = z
  .object({
    /** Makaio session that owns the container runtime. */
    sessionId: z.string().trim().min(1),
    /** Adapter implementation that compiled the delivery. */
    adapterName: z.string().trim().min(1),
    /** Provider config whose refs were resolved by the trusted host. */
    providerConfigId: z.string().trim().min(1),
    /** Provider definition selected by the provider config. */
    definitionId: z.string().trim().min(1),
    /** Session runtime authorized to consume the auth envelope. */
    runtime: ContainerSessionRuntimeBindingSchema,
    /** Portable normalized auth selection represented by this envelope. */
    auth: z
      .object({
        mode: z.enum(['explicit', 'none']),
        method: AuthMethodRefSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((selector, ctx) => {
    if (
      selector.auth.method.owner === 'provider' &&
      selector.auth.method.providerDefinitionId !== selector.definitionId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider-owned auth method must belong to the selected provider definition.',
        path: ['auth', 'method', 'providerDefinitionId'],
      });
    }
  })
  .readonly();
export type ContainerAdapterAuthSelector = z.infer<typeof ContainerAdapterAuthSelectorSchema>;

/** One adapter-owned connector delivery already compiled by the trusted host. */
export const ContainerConnectorAuthDeliverySchema = z
  .object({
    /** Adapter-owned connector operation identifier. */
    target: z.string().trim().min(1),
    /** Plaintext field values and explicit null suppressions for the target. */
    values: z.record(z.string().trim().min(1), ContainerConnectorAuthValueSchema).readonly(),
  })
  .strict()
  .readonly();
export type ContainerConnectorAuthDelivery = z.infer<typeof ContainerConnectorAuthDeliverySchema>;

/**
 * Host-compiled adapter authentication material for one container invocation.
 *
 * The trusted host compiles one selected portable method into this envelope;
 * the container consumes it once through the adapter runtime preparer.
 */
export const ContainerAdapterAuthEnvelopeSchema = z
  .object({
    /** Exact runtime coordinates authorized to consume this material. */
    selector: ContainerAdapterAuthSelectorSchema,
    /** Complete adapter auth environment scrub set. */
    scrubEnvVars: z.array(AuthEnvironmentVariableNameSchema).readonly(),
    /** Selected plaintext process-environment delivery. */
    processEnv: z.record(AuthEnvironmentVariableNameSchema, z.string()).readonly(),
    /** Selected plaintext adapter-owned connector deliveries. */
    connectorDeliveries: z.array(ContainerConnectorAuthDeliverySchema).readonly(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const scrubEnvVars = new Set<string>();
    for (const [index, variable] of envelope.scrubEnvVars.entries()) {
      if (scrubEnvVars.has(variable)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate scrub environment variable "${variable}".`,
          path: ['scrubEnvVars', index],
        });
      }
      scrubEnvVars.add(variable);
    }

    for (const variable of Object.keys(envelope.processEnv)) {
      if (!scrubEnvVars.has(variable)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Every process-environment auth delivery must also belong to the scrub set.',
          path: ['processEnv', variable],
        });
      }
    }

    const connectorTargets = new Set<string>();
    for (const [index, delivery] of envelope.connectorDeliveries.entries()) {
      if (connectorTargets.has(delivery.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate connector auth target "${delivery.target}".`,
          path: ['connectorDeliveries', index, 'target'],
        });
      }
      connectorTargets.add(delivery.target);
    }
  })
  .readonly();
export type ContainerAdapterAuthEnvelope = z.infer<typeof ContainerAdapterAuthEnvelopeSchema>;

/**
 * One-shot stdin bootstrap payload written by the host before the container
 * entrypoint reads from stdin.
 *
 * Fields are optional because some runtime roles require only a subset of the
 * private material. Bootstrap secrets never fall back to process environment.
 * Adapter authentication uses only the selector-bound `adapterAuth` envelope;
 * legacy free-form credential/provider environment maps are rejected.
 */
export const ContainerBootstrapConfigSchema = z
  .object({
    /**
     * HMAC secret for authenticating bus WebSocket connections.
     * Workflow containers receive a per-execution secret; session containers may
     * receive the host-wide secret when authenticated direct bus access is used.
     */
    busAuthSecret: z.string().optional(),
    /**
     * Git access token for cloning private repositories inside the container.
     * Replaces the `MAKAIO_GIT_TOKEN` environment variable.
     */
    gitToken: z.string().optional(),
    /**
     * Runtime environment applied by the entrypoint after reading stdin.
     *
     * Arbitrary environment names cannot be proven secret-free, so this map is
     * deliberately confined to the encrypted bootstrap channel instead of the
     * remotely routable Docker descriptor or Docker's inspectable `Env` array.
     */
    runtimeEnv: z.record(AuthEnvironmentVariableNameSchema, z.string()).optional(),
    /** Exact adapter package set and runtime identity for a session container. */
    sessionRuntime: ContainerSessionRuntimeBindingSchema.optional(),
    /**
     * Normalized adapter auth material. It remains process-local on the
     * host, crosses only the encrypted bootstrap channel, and is delivered to
     * the container over its one-shot stdin stream.
     */
    adapterAuth: ContainerAdapterAuthEnvelopeSchema.optional(),
  })
  .strict();
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

const SpawnRequestBase = z
  .object({
    /** Unique session identifier */
    sessionId: z.string(),
    /** Adapter to load in container */
    adapter: z.string(),
    /** Container runtime type */
    runtime: ContainerRuntimeSchema.default('simple'),
    /** Override base image */
    image: z.string().optional(),
  })
  .strict();

const GIT_REMOTE_PROTOCOLS = new Set(['git:', 'http:', 'https:', 'ssh:']);
const SCP_LIKE_GIT_REMOTE = /^git@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[^\s?#]+$/;

/**
 * Check one URL-shaped remote without ever returning its potentially secret value.
 * @param value - Untrusted public descriptor field.
 * @param protocols - Explicitly supported URL protocols.
 * @param allowUsername - Whether a non-secret transport username is supported.
 * @returns Whether the value is a credential-free URL in the allowed protocol set.
 */
function isCredentialFreeUrl(value: string, protocols: ReadonlySet<string>, allowUsername: boolean): boolean {
  const schemeSeparator = value.indexOf('://');
  if (
    value.length === 0 ||
    value.trim() !== value ||
    schemeSeparator <= 0 ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (
      !protocols.has(parsed.protocol) ||
      parsed.hostname.length === 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return false;
    }

    const authority = value.slice(schemeSeparator + 3).split('/', 1)[0] ?? '';
    const hasUserInfo = authority.includes('@');
    return allowUsername ? !hasUserInfo || parsed.username.length > 0 : !hasUserInfo && parsed.username.length === 0;
  } catch {
    return false;
  }
}

/**
 * Check one Git remote accepted by the isolated-container clone path.
 * @param value - Untrusted public repository remote.
 * @returns Whether the remote is supported and contains no credential-bearing component.
 */
function isCredentialFreeGitRemote(value: string): boolean {
  if (SCP_LIKE_GIT_REMOTE.test(value)) return true;
  try {
    const protocol = new URL(value).protocol;
    return isCredentialFreeUrl(value, GIT_REMOTE_PROTOCOLS, protocol === 'ssh:');
  } catch {
    return false;
  }
}

/** Public Git remote that cannot carry URL credentials, query parameters, or fragments. */
export const CredentialFreeGitRemoteSchema = z.string().refine(isCredentialFreeGitRemote, {
  message: 'Repository remote must use a supported credential-free Git URL.',
});

/**
 * Spawn request for container-local mode.
 */
const ContainerLocalSpawnRequestBaseSchema = SpawnRequestBase.extend({
  mode: z.literal('container-local'),
  /** Host path to git repository */
  repoPath: z.string(),
  /** Branch to fork from */
  baseBranch: z.string(),
  /** Branch to create */
  worktreeBranch: z.string().optional(),
}).strict();

/** Session-local container request with no workflow execution identity. */
const ContainerLocalSessionSpawnRequestSchema = ContainerLocalSpawnRequestBaseSchema;

/** Container-local workflow request with one complete execution identity. */
export const ContainerLocalWorkflowSpawnRequestSchema = ContainerLocalSpawnRequestBaseSchema.extend({
  /** Workflow execution identifier. */
  executionId: z.string(),
  /** Authority-created attempt identifier for this workflow dispatch. */
  executionAttemptId: z.string(),
}).strict();
export type ContainerLocalWorkflowSpawnRequest = z.infer<typeof ContainerLocalWorkflowSpawnRequestSchema>;

/**
 * Container-local requests are either session-only or have a complete workflow
 * execution identity. Partial identities are invalid by construction.
 */
export const ContainerLocalSpawnRequestSchema = z.union([
  ContainerLocalSessionSpawnRequestSchema,
  ContainerLocalWorkflowSpawnRequestSchema,
]);
export type ContainerLocalSpawnRequest = z.infer<typeof ContainerLocalSpawnRequestSchema>;

/**
 * Spawn request for container-isolated mode.
 */
export const ContainerIsolatedSpawnRequestSchema = SpawnRequestBase.extend({
  mode: z.literal('container-isolated'),
  /** Git remote URL to clone */
  repoUrl: CredentialFreeGitRemoteSchema,
  /** Branch to check out inside the container. When omitted, the repo's default branch is cloned. */
  branch: z.string().optional(),
}).strict();
export type ContainerIsolatedSpawnRequest = z.infer<typeof ContainerIsolatedSpawnRequestSchema>;

/**
 * Discriminated spawn request union.
 */
export const SpawnRequestSchema = z.union([ContainerLocalSpawnRequestSchema, ContainerIsolatedSpawnRequestSchema]);
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/**
 * Atomic encrypted-channel request for a descriptor plus plaintext bootstrap.
 *
 * This shape is channel-only at the namespace layer. Keeping it separate from
 * {@link SpawnRequestSchema} prevents bootstrap material from entering the
 * remotely routable Docker descriptor.
 */
export const ContainerBootstrapSpawnRequestSchema = z
  .object({
    /** Public, secret-free Docker spawn descriptor. */
    descriptor: SpawnRequestSchema,
    /** Plaintext material serialized to stdin only by DockerService. */
    bootstrapConfig: ContainerBootstrapConfigSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const selector = request.bootstrapConfig.adapterAuth?.selector;
    if (selector === undefined) return;

    if (selector.sessionId !== request.descriptor.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Container auth selector session must match the Docker descriptor.',
        path: ['bootstrapConfig', 'adapterAuth', 'selector', 'sessionId'],
      });
    }
    if (selector.adapterName !== request.descriptor.adapter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Container auth selector adapter must match the Docker descriptor.',
        path: ['bootstrapConfig', 'adapterAuth', 'selector', 'adapterName'],
      });
    }

    const sessionRuntime = request.bootstrapConfig.sessionRuntime;
    if (sessionRuntime === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Container auth selector requires a session runtime binding.',
        path: ['bootstrapConfig', 'sessionRuntime'],
      });
      return;
    }
    if (selector.runtime.machineId !== sessionRuntime.machineId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Container auth selector machine must match the session runtime.',
        path: ['bootstrapConfig', 'adapterAuth', 'selector', 'runtime', 'machineId'],
      });
    }
    if (
      selector.runtime.packageNames.length !== sessionRuntime.packageNames.length ||
      selector.runtime.packageNames.some((packageName, index) => packageName !== sessionRuntime.packageNames[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Container auth selector packages must exactly match the session runtime selection.',
        path: ['bootstrapConfig', 'adapterAuth', 'selector', 'runtime', 'packageNames'],
      });
    }
  })
  .readonly();
export type ContainerBootstrapSpawnRequest = z.infer<typeof ContainerBootstrapSpawnRequestSchema>;

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
