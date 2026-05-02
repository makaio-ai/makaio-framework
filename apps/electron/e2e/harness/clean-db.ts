/**
 * Delete the temp e2e database before server start.
 *
 * Run as a prefix command in the Playwright webServer command so each test
 * run starts from a clean database state.
 */
import { cleanupE2EDatabase } from './db-path.js';

cleanupE2EDatabase();
