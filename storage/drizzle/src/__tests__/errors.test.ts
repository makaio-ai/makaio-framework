/**
 * Tests for the SQLite error classifiers backing the built-in engine:
 * {@link isSqliteDuplicateObjectError} and {@link isSqliteUniqueViolationError}.
 *
 * The Postgres classifiers live in `@makaio/storage-pg` and are pinned by
 * that package's engine tests.
 */
import { describe, it, expect } from 'vitest';
import { sqliteStorageEngine } from '../engine/sqlite/engine';
import { isSqliteDuplicateObjectError, isSqliteUniqueViolationError } from '../errors';

// ---------------------------------------------------------------------------
// isSqliteDuplicateObjectError
// ---------------------------------------------------------------------------

describe('isSqliteDuplicateObjectError', () => {
  it('matches the "already exists" message text', () => {
    const error = new Error('table foo already exists');

    expect(isSqliteDuplicateObjectError(error)).toBe(true);
  });

  it('matches case-insensitively', () => {
    const error = new Error('Table already exists');

    expect(isSqliteDuplicateObjectError(error)).toBe(true);
  });

  it('matches via cause chain', () => {
    const inner = new Error('table bar already exists');
    const outer = new Error('wrapped', { cause: inner });

    expect(isSqliteDuplicateObjectError(outer)).toBe(true);
  });

  it('returns false for an unrelated SQLite error message', () => {
    const error = new Error('no such table: foo');

    expect(isSqliteDuplicateObjectError(error)).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isSqliteDuplicateObjectError('already exists')).toBe(false);
    expect(isSqliteDuplicateObjectError(null)).toBe(false);
    expect(isSqliteDuplicateObjectError(undefined)).toBe(false);
  });

  it('is wired as the engine error classifier', () => {
    expect(sqliteStorageEngine.errors.isDuplicateObjectError).toBe(isSqliteDuplicateObjectError);
  });
});

// ---------------------------------------------------------------------------
// isSqliteUniqueViolationError
// ---------------------------------------------------------------------------

describe('isSqliteUniqueViolationError', () => {
  it('matches the "UNIQUE constraint failed" message text', () => {
    const error = new Error('UNIQUE constraint failed: turns.session_id, turns.turn_number');

    expect(isSqliteUniqueViolationError(error)).toBe(true);
  });

  it('matches via cause chain', () => {
    const inner = new Error('UNIQUE constraint failed: sessions.session_id');
    const outer = new Error('wrapped', { cause: inner });

    expect(isSqliteUniqueViolationError(outer)).toBe(true);
  });

  it('returns false for an unrelated SQLite error message', () => {
    const error = new Error('no such table: foo');

    expect(isSqliteUniqueViolationError(error)).toBe(false);
  });

  it('returns false for non-error inputs', () => {
    expect(isSqliteUniqueViolationError(null)).toBe(false);
    expect(isSqliteUniqueViolationError(undefined)).toBe(false);
  });

  it('backs the engine classifier with the constraint scope ignored', () => {
    // SQLite errors carry the violated column list, not constraint names —
    // the engine's classifier ignores the optional scope when delegating here.
    const violation = new Error('UNIQUE constraint failed: turns.session_id, turns.turn_number');

    expect(sqliteStorageEngine.errors.isUniqueViolationError(violation, 'uniq_turns_session_number')).toBe(true);
    expect(sqliteStorageEngine.errors.isUniqueViolationError(violation)).toBe(true);
  });
});
