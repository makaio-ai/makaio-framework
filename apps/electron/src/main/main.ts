/**
 * Electron main-process composition root.
 *
 * Mirrors the CLI serve composition root (`apps/cli/src/serve.ts`)
 * with desktop chrome layered on top. Creates the HTTP server, delegates all
 * service/adapter/plugin wiring to {@link bootMakaioRuntime}, then wires
 * Electron-specific concerns: windows, tray, notifications, session
 * persistence.
 *
 * The bus server runs in-process — there is no external daemon, no health
 * polling, no disconnect recovery. The renderer connects via WebSocket to
 * `ws://127.0.0.1:<port>/bus`.
 *
 * Desktop chrome bus handlers are extracted to `bus-handlers.ts` to keep this
 * file within the `max-lines` limit while centralising startup/shutdown
 * dependency order here.
 * @packageDocumentation
 */

import { app } from 'electron';

import { IS_DEV } from './utils.ts';
import { startApp } from './app.ts';

// ── Single-instance lock ──────────────────────────────────────────────────────
// In production the CLI launcher connects to a known instance, so we must
// enforce exactly one. In dev, multiple instances are normal (orphaned
// processes, test alongside dev, etc.) so skip the lock.

const gotLock = IS_DEV || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  startApp();
}
