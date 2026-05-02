/**
 * Framework CLI entry point for `ELECTRON_RUN_AS_NODE=1` invocation.
 *
 * Built as `dist/cli.mjs` in the Electron asar. Platform shell launchers
 * (`makaio-launcher.sh`, `makaio.cmd`) set `ELECTRON_RUN_AS_NODE=1` and exec
 * the Electron binary with this module as the argument.
 */
import { main } from '@makaio/cli';

void main();
