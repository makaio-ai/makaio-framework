import { createBusNamespace } from '@makaio/core';
import type { SchemaRecord } from '@makaio/core';
import {
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

const DockerSchemas = {
  'container.spawn': {
    request: SpawnRequestSchema,
    response: SpawnResponseSchema,
  },
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
