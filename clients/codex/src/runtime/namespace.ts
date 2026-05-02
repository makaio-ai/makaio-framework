/**
 * Codex client namespace registration.
 *
 * Registers `client:codex` on the singleton bus using the shared
 * {@link createClientNamespace} factory, which pre-registers the raw catch-all
 * hook ingress subject `hook.received` with the canonical
 * {@link RawClientHookPayloadSchema}.
 *
 * Additional subjects registered here:
 * - `config.hooks.list` — list effective hook configuration
 * - `config.hooks.add` — add a hook entry to a config scope
 * - `config.hooks.remove` — remove hook entries matching a pattern
 * - `wiring.list` — list all wiring entries with installation status
 * - `wiring.apply` — install wiring entries into the target scope
 * - `wiring.remove` — uninstall wiring entries from the target scope
 *
 * **Subject conventions:**
 * - Raw Codex-native events flow in the `client:codex.*` namespace only.
 * - Normalized lifecycle observations flow in the global `client.session.*`
 *   namespace after the {@link CodexHookNormalizer} maps them.
 * @packageDocumentation
 */

import { createClientNamespace } from '@makaio/clients-core';
import { CodexConfigSchemas } from '../schemas/config.js';
import { CodexWiringSchemas } from '../schemas/wiring.js';

const { subjects, namespaceDomain } = createClientNamespace('codex', {
  ...CodexConfigSchemas,
  ...CodexWiringSchemas,
});

/**
 * Typed bus subjects for the Codex client namespace (`client:codex.*`).
 *
 * Exposes the raw hook ingress subject, config management subjects, and
 * wiring management subjects:
 * - `CodexClientSubjects.hook.received` → `client:codex.hook.received`
 * - `CodexClientSubjects.config.hooks.list` → `client:codex.config.hooks.list`
 * - `CodexClientSubjects.config.hooks.add` → `client:codex.config.hooks.add`
 * - `CodexClientSubjects.config.hooks.remove` → `client:codex.config.hooks.remove`
 * - `CodexClientSubjects.wiring.list` → `client:codex.wiring.list`
 * - `CodexClientSubjects.wiring.apply` → `client:codex.wiring.apply`
 * - `CodexClientSubjects.wiring.remove` → `client:codex.wiring.remove`
 */
export const CodexClientSubjects = subjects;

/**
 * Fully-qualified namespace domain string for the Codex client.
 *
 * Value: `'client:codex'`
 */
export const CODEX_CLIENT_NAMESPACE = namespaceDomain;
