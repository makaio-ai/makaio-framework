/**
 * Host process for the launch stop tests: launches a long-running child whose
 * signals are all denied, awaits the result and then ends by itself. The test
 * proves from the outside that an unobserved exit does not keep this process
 * alive although the child still runs. Prints one JSON line with the status,
 * the exit kind and the child's PID, so the test can remove the child.
 */
import { launch } from '../../launch.js';
import { denyingPort } from './jsonl-children.js';

const launched = launch({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  cwd: process.cwd(),
  envMode: 'merge',
  timeoutMs: 100,
  killGraceMs: 100,
  exitObservationMs: 100,
  quiescenceProofTimeoutMs: 200,
  output: { kind: 'ignore' },
  signalPort: denyingPort(),
});

const result = await launched.result;
process.stdout.write(
  `${JSON.stringify({ status: result.status, exitKind: result.exit?.kind, pid: launched.pid })}\n`,
);
