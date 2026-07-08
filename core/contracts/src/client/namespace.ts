/**
 * Client namespace definition.
 *
 * Defines the global `client.*` namespace for scan, account observation
 * (`client.account.observe`, `client.account.activate`, `client.account.getActive`),
 * usage ingestion/snapshot, runtime observation (`client.runtime.observe`,
 * `client.runtime.started`, `client.runtime.isAdapterManaged`),
 * observed session semantics subjects
 * (`client.session.started`, `client.session.userPrompt.submitted`,
 * `client.session.turn.started`, `client.session.turn.completed`,
 * `client.session.tool.pre`, `client.session.tool.post`), the global
 * wiring aggregator (`client.wiring.list`), the binary management
 * subjects (`client.list`, `client.install`, `client.uninstall`,
 * `client.update`, `client.setActive`, `client.installJob.progress`,
 * `client.installJob.completed`, `client.version.changed`), the binary
 * resolution command (`client.resolveBinary`), the profile management
 * subjects (`client.profile.create`, `client.profile.list`,
 * `client.profile.get`, `client.profile.update`, `client.profile.delete`,
 * `client.profile.setDefault`), the session config lifecycle subjects
 * (`client.sessionConfig.create`, `client.sessionConfig.destroy`,
 * `client.sessionConfig.cleanup`), and the generic blocking config-prime
 * lifecycle hook (`client.config.prime`).
 * @packageDocumentation
 */

import { createBusNamespace } from '@makaio/core';
import { ClientSchemas } from './schemas.js';

/**
 * Client namespace definition under the `client` prefix.
 */
export const ClientNamespace = createBusNamespace('client', ClientSchemas);

/**
 * Typed bus subjects for the client namespace.
 */
export const ClientSubjects = ClientNamespace.subjects;
