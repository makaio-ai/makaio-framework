/**
 * Smoke tests for CodexAppServerConnector.changeModelInPlace()
 *
 * Codex accepts model per-turn via `turn/start`, so no SDK session
 * needs reconfiguring — the override simply returns true, and the caller
 * is responsible for updating `connector.model` before the next turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  type ConnectorTestContext,
} from '../src/__tests__/shared.js';

describe('CodexAppServerConnector.changeModelInPlace()', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('always returns true (Codex supports per-turn model switching)', async () => {
    expect(await ctx.connector.changeModelInPlace('o4-mini')).toBe(true);
  });

  it('does not mutate connector.model (caller owns the mutation)', async () => {
    const originalModel = ctx.connector.model;
    await ctx.connector.changeModelInPlace('o4-mini');
    expect(ctx.connector.model).toBe(originalModel);
  });
});
