import { withCodexNativeAuthSourceLock } from '../../native-auth-source-lock.js';

const codexHome = process.argv[2];
if (codexHome === undefined) throw new Error('Expected CODEX_HOME argument.');

await withCodexNativeAuthSourceLock(codexHome, async () => {
  process.stdout.write('LOCKED\n');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
});
