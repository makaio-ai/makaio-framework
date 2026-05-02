/**
 * Public CLI RPC schema entrypoint.
 *
 * Keeps the package export surface aligned with the published `./cli/schemas`
 * subpath while the implementation stays colocated under `src/bus/cli`.
 */
export { CliSchemas } from '../bus/cli/schemas.js';
