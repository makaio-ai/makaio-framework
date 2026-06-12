/**
 * Tests for dialect-aware error classification:
 * {@link isDuplicateObjectError} and {@link isUniqueViolationError}.
 */
import { describe, it, expect } from 'vitest';
import { isDuplicateObjectError, isUniqueViolationError } from '../errors';

// ---------------------------------------------------------------------------
// isDuplicateObjectError
// ---------------------------------------------------------------------------

describe('isDuplicateObjectError', () => {
  describe('postgres dialect', () => {
    it('matches SQLSTATE 42P07 (duplicate_table)', () => {
      const error = Object.assign(new Error('duplicate table'), { code: '42P07' });

      expect(isDuplicateObjectError(error, 'postgres')).toBe(true);
    });

    it('matches SQLSTATE 42710 (duplicate_object)', () => {
      const error = Object.assign(new Error('duplicate object'), { code: '42710' });

      expect(isDuplicateObjectError(error, 'postgres')).toBe(true);
    });

    it('matches the code anywhere in the cause chain', () => {
      const inner = Object.assign(new Error('original pg error'), { code: '42P07' });
      const outer = new Error('wrapped', { cause: inner });

      expect(isDuplicateObjectError(outer, 'postgres')).toBe(true);
    });

    it('returns false for an unrelated Postgres error code', () => {
      const error = Object.assign(new Error('syntax error'), { code: '42601' });

      expect(isDuplicateObjectError(error, 'postgres')).toBe(false);
    });

    it('returns false when no code property is present', () => {
      const error = new Error('already exists');

      // Postgres branch checks code, not message — should not match.
      expect(isDuplicateObjectError(error, 'postgres')).toBe(false);
    });
  });

  describe('sqlite dialect', () => {
    it('matches the "already exists" message text', () => {
      const error = new Error('table foo already exists');

      expect(isDuplicateObjectError(error, 'sqlite')).toBe(true);
    });

    it('matches case-insensitively', () => {
      const error = new Error('Table already exists');

      expect(isDuplicateObjectError(error, 'sqlite')).toBe(true);
    });

    it('matches via cause chain', () => {
      const inner = new Error('table bar already exists');
      const outer = new Error('wrapped', { cause: inner });

      expect(isDuplicateObjectError(outer, 'sqlite')).toBe(true);
    });

    it('returns false for an unrelated SQLite error message', () => {
      const error = new Error('no such table: foo');

      expect(isDuplicateObjectError(error, 'sqlite')).toBe(false);
    });
  });

  describe('non-error inputs', () => {
    it('returns false for a plain string', () => {
      expect(isDuplicateObjectError('already exists', 'sqlite')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isDuplicateObjectError(null, 'postgres')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isDuplicateObjectError(undefined, 'sqlite')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isUniqueViolationError
// ---------------------------------------------------------------------------

describe('isUniqueViolationError', () => {
  describe('postgres dialect', () => {
    it('matches SQLSTATE 23505 (unique_violation)', () => {
      const error = Object.assign(new Error('duplicate key value'), { code: '23505' });

      expect(isUniqueViolationError(error, 'postgres')).toBe(true);
    });

    it('matches the code anywhere in the cause chain', () => {
      const inner = Object.assign(new Error('original pg error'), { code: '23505' });
      const outer = new Error('wrapped', { cause: inner });

      expect(isUniqueViolationError(outer, 'postgres')).toBe(true);
    });

    it('scopes the match to the given constraint name', () => {
      const error = Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'turns_session_id_turn_number_unique',
      });

      expect(isUniqueViolationError(error, 'postgres', 'turns_session_id_turn_number_unique')).toBe(true);
      expect(isUniqueViolationError(error, 'postgres', 'some_other_constraint')).toBe(false);
    });

    it('returns false for an unrelated Postgres error code', () => {
      const error = Object.assign(new Error('syntax error'), { code: '42601' });

      expect(isUniqueViolationError(error, 'postgres')).toBe(false);
    });
  });

  describe('sqlite dialect', () => {
    it('matches the "UNIQUE constraint failed" message text', () => {
      const error = new Error('UNIQUE constraint failed: turns.session_id, turns.turn_number');

      expect(isUniqueViolationError(error, 'sqlite')).toBe(true);
    });

    it('matches via cause chain', () => {
      const inner = new Error('UNIQUE constraint failed: sessions.session_id');
      const outer = new Error('wrapped', { cause: inner });

      expect(isUniqueViolationError(outer, 'sqlite')).toBe(true);
    });

    it('returns false for an unrelated SQLite error message', () => {
      const error = new Error('no such table: foo');

      expect(isUniqueViolationError(error, 'sqlite')).toBe(false);
    });
  });

  describe('non-error inputs', () => {
    it('returns false for null and undefined', () => {
      expect(isUniqueViolationError(null, 'postgres')).toBe(false);
      expect(isUniqueViolationError(undefined, 'sqlite')).toBe(false);
    });
  });
});
