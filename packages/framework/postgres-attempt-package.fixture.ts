/** Consumer modules: every Makaio import resolves from the installed package pair. */
export const RUNTIME_CONSUMER = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { createPostgresExecutionAttemptRepository } from '@makaio/storage-pg';
import { ExecutionAttemptAuthority, durableOutcome } from '@makaio/framework/workflow-engine';

const require = createRequire(import.meta.url);
const installedMakaioRoot = resolve(process.cwd(), 'node_modules', '@makaio');
for (const specifier of ['@makaio/storage-pg', '@makaio/framework/workflow-engine']) {
  const resolved = require.resolve(specifier);
  assert.equal(resolved.startsWith(installedMakaioRoot + sep), true, resolved);
}
assert.equal(typeof createPostgresExecutionAttemptRepository, 'function');
assert.equal(typeof ExecutionAttemptAuthority, 'function');
assert.deepEqual(
  durableOutcome({ parse: (value) => value, serialize: (value) => JSON.stringify(value) }, { installed: true }),
  { outcome: { installed: true }, text: '{"installed":true}' },
);
`;

/** Type witnesses compile against the installed public package pair only. */
export const TYPES_CONSUMER = String.raw`
import { createPostgresExecutionAttemptRepository } from '@makaio/storage-pg';
import type { MakaioDatabase } from '@makaio/framework/storage/drizzle';
import {
  ExecutionAttemptAuthority,
  type ExecutionAttemptRepository,
  type OutcomeCodec,
} from '@makaio/framework/workflow-engine';

export type PublicPostgresFactory = <TOutcome>(
  db: MakaioDatabase,
  codec: OutcomeCodec<TOutcome>,
) => Promise<Required<ExecutionAttemptRepository<TOutcome>>>;

export const postgresAttemptFactory: PublicPostgresFactory = createPostgresExecutionAttemptRepository;
export const authority: typeof ExecutionAttemptAuthority = ExecutionAttemptAuthority;
`;
