/**
 * Variant upgrade handler for the Electrobun desktop host.
 *
 * Wires the `host:variant.requestUpgrade` bus subject to the Electrobun Updater API.
 * When a client requests a switch to a different build variant, this module:
 *
 * 1. Rejects the request if the running variant already matches the target.
 * 2. Rewrites `version.json` atomically to point the Updater at the target
 *    variant's release channel.
 * 3. Accepts the request immediately and fires off the download + apply
 *    pipeline in the background, streaming progress via `host:variant.upgradeProgress`
 *    bus events.
 * 4. Restores the original `version.json` on error so the Updater stays in a
 *    consistent state on the next launch.
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { MakaioBus } from '@makaio/bus-core';
import { Updater, type UpdateStatusType } from 'electrobun/bun';
import { VariantSubjects } from '@makaio/contracts/variant';
import type { VariantConfig, MakaioVariant } from '../variant-config.js';
import { resolveVariantReleaseChannel } from '../variant-config.js';
import type { VariantUpgradeStatus } from '@makaio/contracts/variant';

/**
 * Shape of the `version.json` file consumed by the Electrobun Updater.
 *
 * Only `channel` is required for variant routing; the remaining fields are
 * preserved verbatim so the Updater's local-info cache stays consistent.
 */
interface VersionJson {
  version: string;
  hash: string;
  baseUrl: string;
  channel: string;
  name: string;
  identifier: string;
}

/**
 * Lookup table mapping granular Electrobun {@link UpdateStatusType} values to
 * the coarser {@link VariantUpgradeStatus} phases reported over the bus.
 *
 * Electrobun emits ~30 fine-grained status values; the bus schema surfaces five
 * phases that are meaningful to UI consumers. Statuses absent from this map
 * (e.g. `'idle'`) are suppressed.
 */
const ELECTROBUN_TO_BUS_STATUS: Readonly<Partial<Record<UpdateStatusType, VariantUpgradeStatus>>> = {
  checking: 'downloading',
  downloading: 'downloading',
  'download-starting': 'downloading',
  'checking-local-tar': 'downloading',
  'local-tar-found': 'downloading',
  'local-tar-missing': 'downloading',
  'fetching-patch': 'downloading',
  'patch-found': 'downloading',
  'patch-not-found': 'downloading',
  'downloading-full-bundle': 'downloading',

  'downloading-patch': 'progress',
  'download-progress': 'progress',
  'applying-patch': 'progress',
  'patch-applied': 'progress',
  'patch-chain-complete': 'progress',
  'extracting-version': 'progress',
  decompressing: 'progress',
  'download-complete': 'progress',

  applying: 'applying',
  extracting: 'applying',
  'replacing-app': 'applying',
  'launching-new-version': 'applying',

  complete: 'complete',
  'check-complete': 'complete',
  'no-update': 'complete',
  'update-available': 'complete',

  error: 'error',
  'patch-failed': 'error',
};

/**
 * Map a raw Electrobun {@link UpdateStatusType} to the coarser
 * {@link VariantUpgradeStatus} reported over the bus.
 * @param status - Raw Electrobun updater status.
 * @returns Coarse bus-level upgrade status, or `null` to suppress the event.
 */
function toVariantUpgradeStatus(status: UpdateStatusType): VariantUpgradeStatus | null {
  return ELECTROBUN_TO_BUS_STATUS[status] ?? null;
}

/**
 * Resolve the absolute path to `version.json` for the running production app.
 *
 * Mirrors the Electrobun Updater's own resolution:
 * `process.execPath -> dirname -> ../ -> Resources/version.json`.
 * @returns Absolute path to the version file.
 */
function resolveVersionJsonPath(): string {
  return path.join(path.dirname(process.execPath), '..', 'Resources', 'version.json');
}

/**
 * Atomically write `version.json` by writing to a temp file then renaming.
 *
 * Atomic rename prevents a crash mid-write from leaving a corrupt file that
 * would break subsequent updater reads.
 * @param versionPath - Absolute path to the target `version.json`.
 * @param content - Serialised JSON content to write.
 */
function writeVersionJsonAtomic(versionPath: string, content: string): void {
  const tmpPath = `${versionPath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, versionPath);
}

/**
 * Emit a `host:variant.upgradeProgress` bus event, swallowing errors so a
 * failed publish never aborts the upgrade pipeline itself.
 * @param status - Coarse upgrade phase.
 * @param percent - Optional completion percentage (0-100).
 * @param message - Optional human-readable status message.
 */
function emitUpgradeProgress(status: VariantUpgradeStatus, percent?: number, message?: string): void {
  MakaioBus.emit(VariantSubjects.upgradeProgress, { status, percent, message }).catch((err: unknown) => {
    console.warn('[electrobun] Failed to emit host:variant.upgradeProgress:', err);
  });
}

/**
 * Run the full Electrobun upgrade pipeline for the target variant.
 *
 * Bridges Electrobun's {@link Updater} status stream to coarse bus events and
 * restores the original `version.json` if the pipeline fails before the app
 * relaunches.
 * @param targetVariant - The variant identifier to upgrade to.
 * @param versionPath - Absolute path to `version.json`.
 * @param originalVersionContent - Raw JSON string of the pre-rewrite file.
 */
async function runUpgradePipeline(
  targetVariant: MakaioVariant,
  versionPath: string,
  originalVersionContent: string,
): Promise<void> {
  let pipelineFailed = false;

  // Wire Electrobun status events to coarse bus progress events.
  Updater.onStatusChange((entry) => {
    const busStatus = toVariantUpgradeStatus(entry.status);
    if (busStatus === null) return;

    const percent = entry.details?.progress;
    emitUpgradeProgress(busStatus, percent, entry.message);
  });

  try {
    emitUpgradeProgress('downloading', 0, `Switching to variant: ${targetVariant}`);

    const checkResult = await Updater.checkForUpdate();
    if (checkResult.error) {
      throw new Error(`Update check failed: ${checkResult.error}`);
    }

    if (!checkResult.updateAvailable) {
      // The target variant channel returned the same hash - nothing to do.
      // Treat as an unexpected state since we already validated the variant differs.
      throw new Error(
        `No update available on channel '${targetVariant}'. ` +
          `The release server may not have a build for this variant yet.`,
      );
    }

    await Updater.downloadUpdate();

    // Verify the download succeeded before attempting to apply.
    const postDownload = Updater.updateInfo();
    if (!postDownload?.updateReady) {
      throw new Error('Download did not complete successfully.');
    }

    emitUpgradeProgress('applying', undefined, 'Applying update and relaunching...');
    await Updater.applyUpdate();

    // applyUpdate() calls quit() internally on success - execution should not
    // reach here. Emit complete defensively in case the platform path skips quit.
    emitUpgradeProgress('complete', 100, `Upgraded to variant: ${targetVariant}`);
  } catch (err: unknown) {
    pipelineFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[electrobun] Variant upgrade pipeline failed:', err);
    emitUpgradeProgress('error', undefined, message);
  } finally {
    // Clear the status callback regardless of outcome.
    Updater.onStatusChange(null);

    if (pipelineFailed) {
      // Restore the original version.json so the next launch uses the correct channel.
      try {
        writeVersionJsonAtomic(versionPath, originalVersionContent);
        console.info('[electrobun] Restored original version.json after upgrade failure.');
      } catch (restoreErr: unknown) {
        console.error('[electrobun] Failed to restore version.json:', restoreErr);
      }
    }
  }
}

/**
 * Register the `host:variant.requestUpgrade` bus handler.
 *
 * The handler validates the request, atomically rewrites `version.json` to
 * route the Electrobun Updater at the target variant's release channel, then
 * returns `{ accepted: true }` immediately while the download + apply
 * pipeline runs in the background.
 *
 * Only one upgrade may be in progress at a time. Concurrent requests while an
 * upgrade is running are rejected with an appropriate message.
 * @param cleanups - Collector for `MakaioBus.on(...)` cleanup callbacks.
 * @param variantConfig - Resolved variant configuration for the running host.
 */
export function registerVariantUpgradeHandler(cleanups: Array<() => void>, variantConfig: VariantConfig): void {
  let upgradeInProgress = false;

  cleanups.push(
    MakaioBus.on(VariantSubjects.requestUpgrade, (ctx) => {
      const { targetVariant } = ctx.payload;

      if (targetVariant === variantConfig.variant) {
        ctx.setResult({ accepted: false, message: 'Already on this variant' });
        return;
      }

      if (upgradeInProgress) {
        ctx.setResult({ accepted: false, message: 'An upgrade is already in progress' });
        return;
      }

      const versionPath = resolveVersionJsonPath();

      let originalVersionContent: string;
      let originalVersion: VersionJson;

      try {
        originalVersionContent = fs.readFileSync(versionPath, 'utf-8');
        originalVersion = JSON.parse(originalVersionContent) as VersionJson;
      } catch (readErr: unknown) {
        const message = readErr instanceof Error ? readErr.message : String(readErr);
        console.error('[electrobun] Failed to read version.json for upgrade:', readErr);
        ctx.setResult({ accepted: false, message: `Cannot read version.json: ${message}` });
        return;
      }

      // Rewrite version.json to route the Updater at the target variant on the current release track.
      const updatedVersion: VersionJson = {
        ...originalVersion,
        channel: resolveVariantReleaseChannel(targetVariant, variantConfig.releaseTrack),
      };
      try {
        writeVersionJsonAtomic(versionPath, JSON.stringify(updatedVersion, null, 2));
      } catch (writeErr: unknown) {
        const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.error('[electrobun] Failed to rewrite version.json for upgrade:', writeErr);
        ctx.setResult({ accepted: false, message: `Cannot rewrite version.json: ${message}` });
        return;
      }

      upgradeInProgress = true;
      ctx.setResult({ accepted: true, message: `Upgrading to variant: ${targetVariant}` });

      // Run the pipeline in the background - do not await here.
      void runUpgradePipeline(targetVariant, versionPath, originalVersionContent).finally(() => {
        upgradeInProgress = false;
      });
    }),
  );
}
