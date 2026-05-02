/** Send a message via session.sendMessage and wait for turn completion. */

import { parseArgs } from 'node:util';
import { BusClient, SessionSubjects, AgentSubjects } from '../src/index.js';

const DEFAULT_MESSAGE = 'Hello, what can you help me with?';
const TURN_TIMEOUT_MS = 30_000;

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    message: { type: 'string' },
  },
});

const model = values.model;
if (!model) {
  console.error('Usage: npx tsx examples/send-message.ts --model <canonical-model>');
  process.exit(1);
}

const message = values.message ?? process.env['MAKAIO_MESSAGE'] ?? DEFAULT_MESSAGE;

/**
 * Return the payload only when it is an object for this example session.
 * @param payload - Event payload received from the bus
 * @param sessionId - Session ID created by this example run
 * @returns Matching object payload, or `undefined` for unrelated events
 */
function payloadForSession(payload: unknown, sessionId: string): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const eventPayload = payload as Record<string, unknown>;
  return eventPayload['sessionId'] === sessionId ? eventPayload : undefined;
}

/** Connect, send a message, print events, then exit on turn completion. */
async function main(): Promise<void> {
  const sessionId = crypto.randomUUID();
  const client = new BusClient();
  await client.connect();

  try {
    let resolveTurn: (() => void) | undefined;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });

    client.subscribe(SessionSubjects.$all, (ctx) => {
      const payload = payloadForSession(ctx.payload, sessionId);
      if (!payload) return;
      console.info(`${ctx.subject}:`, JSON.stringify(payload));
      if (ctx.subject === 'session.turn.completed') resolveTurn?.();
    });

    client.subscribe(AgentSubjects.$all, (ctx) => {
      const payload = payloadForSession(ctx.payload, sessionId);
      if (!payload) return;
      console.info(`${ctx.subject}:`, JSON.stringify(payload));
    });

    const response = await client.request(
      SessionSubjects.sendMessage,
      { sessionId, agent: { kind: 'canonical-model', model }, message },
      { timeout: TURN_TIMEOUT_MS },
    );

    console.info(`session_id=${sessionId}`);
    console.info(JSON.stringify(response));

    let turnTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      turnTimeoutId = setTimeout(() => {
        reject(new Error('Timed out waiting for session.turn.completed'));
      }, TURN_TIMEOUT_MS);
    });

    await Promise.race([turnCompleted, timedOut]);
    if (turnTimeoutId) clearTimeout(turnTimeoutId);
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
