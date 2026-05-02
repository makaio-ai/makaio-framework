import { describe, expect, it } from 'vitest';
import { JsonFormatter } from '../src/formatters/json.js';
import { StreamJsonFormatter } from '../src/formatters/stream-json.js';
import { resolveExitCode } from '../src/formatters/types.js';
import type { OutputWriter, TurnResult } from '../src/formatters/types.js';

function createWriter(): OutputWriter & { stdout: string; stderr: string } {
  return {
    stdout: '',
    stderr: '',
    write(text: string): void {
      this.stdout += text;
    },
    error(text: string): void {
      this.stderr += text;
    },
  };
}

const successfulTurn: TurnResult = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  turnNumber: 1,
  success: true,
};

const agentEventBase = {
  agentId: 'agent-1',
  adapterId: 'adapter-1',
  adapterName: 'adapter',
  adapterSessionId: 'adapter-session-1',
  sessionId: 'session-1',
};

describe('Prompt formatters', () => {
  it('does not duplicate final agent.message content after streaming deltas', () => {
    const writer = createWriter();
    const formatter = new JsonFormatter(writer);

    formatter.handleEvent('agent.message_delta', {
      ...agentEventBase,
      text: 'Hel',
    });
    formatter.handleEvent('agent.message_delta', {
      ...agentEventBase,
      text: 'lo',
    });
    formatter.handleEvent('agent.message', {
      ...agentEventBase,
      content: 'Hello',
    });

    expect(formatter.flush(successfulTurn)).toBe(0);
    expect(JSON.parse(writer.stdout)).toMatchObject({
      result: 'Hello',
      num_turns: 1,
    });
    expect(writer.stdout.endsWith('\n')).toBe(true);
  });

  it('uses turn completion errors as result text for JSONL failures', () => {
    const writer = createWriter();
    const formatter = new StreamJsonFormatter('session-1', Date.now(), writer);

    expect(
      formatter.flush({
        sessionId: 'session-1',
        turnId: 'turn-1',
        turnNumber: 2,
        success: false,
        error: 'Model failed',
      }),
    ).toBe(1);

    const resultLine = JSON.parse(writer.stdout.trim()) as Record<string, unknown>;
    expect(resultLine).toMatchObject({
      type: 'result',
      subtype: 'error',
      is_error: true,
      num_turns: 2,
      result: 'Model failed',
    });
  });

  it('maps rate-limit errors only on failed turns', () => {
    expect(resolveExitCode('rate_limit', false)).toBe(2);
    expect(resolveExitCode('rate_limit', true)).toBe(0);
  });
});
