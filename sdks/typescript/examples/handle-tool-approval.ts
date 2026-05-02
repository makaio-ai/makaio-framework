/** Handle tool approval requests with risk-based decision logic. */

import { BusClient, ApprovalSubjects, ToolSubjects } from '../src/index.js';

/** Approval request payload shape (subset of the full schema used in this example). */
interface ApprovalPayload {
  toolName?: string;
  riskLevel?: 'safe' | 'neutral' | 'destructive';
  capabilities?: readonly string[];
}

/** Tool execute request payload shape. */
interface ToolExecutePayload {
  toolName: string;
  input: unknown;
}

/** Connect to the bus and handle tool approval requests until SIGINT or SIGTERM. */
async function main(): Promise<void> {
  const client = new BusClient();
  await client.connect();

  const stop = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  client.onRequest<ApprovalPayload>(ApprovalSubjects.request, (ctx) => {
    const { toolName, riskLevel, capabilities } = ctx.payload;
    const capsDisplay = capabilities && capabilities.length > 0 ? capabilities.join(', ') : 'none';

    console.info(
      `approval.request: tool=${toolName ?? '(unknown)'}  risk=${riskLevel ?? 'unknown'}  capabilities=[${capsDisplay}]`,
    );

    if (riskLevel === 'destructive') {
      ctx.setResult({ action: 'deny', message: 'Destructive operations require manual approval' });
    } else {
      ctx.setResult({ action: 'allow' });
    }
  });

  client.onRequest<ToolExecutePayload>(ToolSubjects.execute, (ctx) => {
    const { toolName, input } = ctx.payload;

    if (toolName === 'example.echo') {
      ctx.setResult({ success: true, data: input });
      return;
    }

    ctx.setResult({
      success: false,
      error: { code: 'UNSUPPORTED_TOOL', message: `Unsupported tool: ${toolName}` },
    });
  });

  console.info(
    `Listening for approval requests on ${process.env['MAKAIO_BUS_URL'] ?? 'ws://localhost:6252/bus'} — press Ctrl+C to stop`,
  );

  await stop;
  client.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
