import { z } from 'zod';
import { channelSubject, createBusNamespace, localSubject } from '@makaio/core';
import type { SchemaRecord } from '@makaio/core';
import {
  ContainerBootstrapSpawnRequestSchema,
  SpawnRequestSchema,
  SpawnResponseSchema,
  StopRequestSchema,
  StopResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
  ContainerCreatedSchema,
  ContainerStartedSchema,
  ContainerStoppedSchema,
  ContainerDestroyedSchema,
} from './container-schemas.js';

/** Process-local DirectChannel endpoint used for plaintext Docker bootstrap. */
export const CONTAINER_BOOTSTRAP_CHANNEL_ENDPOINT = 'docker-bootstrap';

const DockerSchemas = {
  /**
   * Spawn a container from one mode-specific public descriptor.
   *
   * `container-local` requires `repoPath` and `baseBranch`.
   * `container-isolated` requires `repoUrl`. Fields belonging
   * only to the other mode are rejected by the strict discriminated union.
   */
  'container.spawn': {
    request: SpawnRequestSchema,
    response: SpawnResponseSchema,
  },
  /**
   * Atomically spawn from a public descriptor plus encrypted bootstrap data.
   * Channel-only because the request contains resolved plaintext secrets.
   */
  'bootstrap.spawn': channelSubject({
    request: ContainerBootstrapSpawnRequestSchema,
    response: SpawnResponseSchema,
  }),
  /** Return the process-local bootstrap channel bearer capability. */
  'bootstrap.getChannelToken': localSubject({
    request: z.object({}),
    response: z.object({ token: z.string().min(1) }),
  }),
  'container.stop': {
    request: StopRequestSchema,
    response: StopResponseSchema,
  },
  'container.status': {
    request: StatusRequestSchema,
    response: StatusResponseSchema,
  },
  'container.created': ContainerCreatedSchema,
  'container.started': ContainerStartedSchema,
  'container.stopped': ContainerStoppedSchema,
  'container.destroyed': ContainerDestroyedSchema,
} satisfies SchemaRecord;

/**
 * Canonical Docker namespace.
 */
export const DockerNamespace = createBusNamespace('docker', DockerSchemas);

/**
 * Typed Docker subjects.
 */
export const DockerSubjects = DockerNamespace.subjects;
