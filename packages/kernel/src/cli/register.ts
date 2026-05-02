/**
 * Public CLI RPC namespace registration entrypoint.
 *
 * Keeps the package export surface aligned with the published `./cli/register`
 * subpath while the implementation stays colocated under `src/bus/cli`.
 */
export { CliNamespace, CliRpcSubjects } from '../bus/cli/namespace.js';
