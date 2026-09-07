import { parentPort } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

parentPort.postMessage('cold-module-loading');
await delay(10_000);
const { default: run } = await import('./piscina-bootstrap-worker.mjs');
export default run;
