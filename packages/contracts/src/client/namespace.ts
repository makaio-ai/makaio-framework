/**
 * Client namespace registration.
 *
 * Registers the global `client.*` namespace for scan, account observation,
 * usage ingestion/snapshot, runtime observation (`client.runtime.observe`,
 * `client.runtime.started`), observed session semantics subjects
 * (`client.session.started`, `client.session.userPrompt.submitted`,
 * `client.session.turn.started`, `client.session.turn.completed`,
 * `client.session.tool.pre`, `client.session.tool.post`), the global
 * wiring aggregator (`client.wiring.list`), the binary management
 * subjects (`client.list`, `client.install`, `client.uninstall`,
 * `client.update`, `client.setActive`, `client.installJob.progress`,
 * `client.installJob.completed`, `client.version.changed`), and the binary
 * resolution command (`client.resolveBinary`).
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { ClientSchemas } from './schemas.js';

/**
 * Client namespace registered under the `client` prefix.
 */
export const ClientNamespace = MakaioBus.registerNamespace('client', ClientSchemas);

/**
 * Typed bus subjects for the client namespace.
 */
export const ClientSubjects = ClientNamespace.subjects;
