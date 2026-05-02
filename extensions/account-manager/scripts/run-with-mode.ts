import { spawn } from 'node:child_process';

/**
 * Run a command with an explicit extension authoring mode.
 *
 * The current source tree uses repo-dev mode to resolve local framework
 * sources directly, while staged portable source packages run the underlying
 * tools without this helper.
 */
async function main(): Promise<void> {
  const [mode, command, ...args] = process.argv.slice(2);

  if (!mode || !command) {
    throw new Error('Usage: tsx ./scripts/run-with-mode.ts <mode> <command> [...args]');
  }

  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      MAKAIO_EXTENSION_MODE: mode,
    },
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited via signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });

  process.exitCode = exitCode;
}

void main().catch((error) => {
  const attemptedMode = process.argv[2];
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[account-manager] Failed to start ${attemptedMode ?? 'unknown'} command: ${message}`);
  process.exitCode = 1;
});
