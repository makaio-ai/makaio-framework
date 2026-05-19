/**
 * Smoke tests for CodexAppServerConnector.changeReasoningInPlace() and
 * the effort-to-protocol mapping applied in turn/start.
 *
 * Codex accepts reasoning effort per-turn via the `effort` field in `turn/start`,
 * so no SDK session needs reconfiguring — the override simply returns true, and the
 * caller (mutation manager) is responsible for updating `connector.currentReasoningEffort`
 * before the next turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithThread,
  type ConnectorTestContext,
} from '../src/__tests__/shared.js';

describe('CodexAppServerConnector.changeReasoningInPlace()', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('always returns true (Codex supports per-turn reasoning effort)', async () => {
    expect(await ctx.connector.changeReasoningInPlace('medium')).toBe(true);
  });

  it('returns true for every canonical reasoning level', async () => {
    const levels = ['none', 'low', 'medium', 'high', 'extra-high'] as const;
    for (const level of levels) {
      expect(await ctx.connector.changeReasoningInPlace(level)).toBe(true);
    }
  });

  it('does not mutate connector.currentReasoningEffort (caller owns the mutation)', async () => {
    const originalEffort = ctx.connector.currentReasoningEffort;
    await ctx.connector.changeReasoningInPlace('high');
    expect(ctx.connector.currentReasoningEffort).toBe(originalEffort);
  });
});

describe('CodexAppServerConnector effort mapping in turn/start', () => {
  let ctx: ConnectorTestContext;

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('passes effort from currentReasoningEffort to turn/start protocol field', async () => {
    ctx = await createConnectorTestContext({ reasoningEffort: 'high' });
    await startConnectorWithThread(ctx);

    const turnStartReq = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStartReq).toBeDefined();
    expect((turnStartReq?.params as { effort: string }).effort).toBe('high');
  });

  it('maps extra-high canonical level to xhigh in turn/start', async () => {
    ctx = await createConnectorTestContext();
    // Simulate mutation manager updating currentReasoningEffort after changeReasoningInPlace
    ctx.connector.currentReasoningEffort = 'extra-high';

    await startConnectorWithThread(ctx);

    const turnStartReq = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStartReq).toBeDefined();
    expect((turnStartReq?.params as { effort: string }).effort).toBe('xhigh');
  });

  it('passes null effort when currentReasoningEffort is undefined', async () => {
    ctx = await createConnectorTestContext(); // no reasoningEffort — currentReasoningEffort is undefined
    await startConnectorWithThread(ctx);

    const turnStartReq = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStartReq).toBeDefined();
    expect((turnStartReq?.params as { effort: unknown }).effort).toBeNull();
  });

  it('passes null effort (not "none") when currentReasoningEffort is "none"', async () => {
    ctx = await createConnectorTestContext();
    // Simulate mutation manager setting 'none' after changeReasoningInPlace
    ctx.connector.currentReasoningEffort = 'none';

    await startConnectorWithThread(ctx);

    const turnStartReq = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/start');
    expect(turnStartReq).toBeDefined();
    // 'none' must be omitted (null) — never forwarded as a string to the Codex protocol.
    expect((turnStartReq?.params as { effort: unknown }).effort).toBeNull();
  });
});
