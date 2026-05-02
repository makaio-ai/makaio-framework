/** Subscribe to agent lifecycle events and print them until SIGINT. */

import { BusClient, AgentSubjects } from '../src/index.js';

/** Connect to the bus and print agent events until SIGINT or SIGTERM. */
async function main(): Promise<void> {
  const client = new BusClient();
  await client.connect();

  const stop = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  client.subscribe(AgentSubjects.$all, (ctx) => {
    const payload = ctx.payload as Record<string, unknown>;

    switch (ctx.subject) {
      case 'agent.started':
        console.info(`agent started — model: ${payload['model'] ?? '(none)'}, cwd: ${payload['cwd'] ?? '(none)'}`);
        break;
      case 'agent.message':
        console.info(`agent message: ${payload['content'] ?? ''}`);
        break;
      case 'agent.tool.use':
        console.info(`tool use: ${payload['toolName'] ?? '(unknown)'} (id=${payload['toolCallId'] ?? ''})`);
        break;
      case 'agent.complete':
        console.info(`agent complete — outcome: ${payload['outcome'] ?? '(none)'}`);
        break;
      default:
        console.info(`${ctx.subject}:`, JSON.stringify(payload));
    }
  });

  console.info('Listening for agent events — press Ctrl+C to stop');
  await stop;
  client.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
