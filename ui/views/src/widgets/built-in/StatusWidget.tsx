/* eslint max-lines-per-function: ["error", { max: 500 }] */
import { useEffect, useRef, useState, type JSX } from 'react';
import { ExtensionSubjects, KernelSubjects, type ExtensionInfo } from '@makaio/kernel';
import { useBus } from '@makaio/ui-hooks';
import type { WidgetDefinition, WidgetProps } from '@makaio/ui-kernel';
import styles from './StatusWidget.module.scss';

/** Maps extension state to a CSS variable value for the status dot background color. */
const STATUS_DOT_STYLE: Record<ExtensionInfo['state'], string> = {
  active: 'var(--color-success)',
  discovered: 'var(--color-text-muted)',
  failed: 'var(--color-danger)',
  initializing: 'var(--color-text-secondary)',
  skipped: 'var(--color-text-muted)',
  stopped: 'var(--color-text-muted)',
};

const COPY_FEEDBACK_TIMEOUT_MS = 2_000;
type CopyFeedbackState = 'idle' | 'success' | 'error';

/**
 * Shorten the machine identity for compact display.
 * @param machineId - Full machine identifier returned by the runtime.
 * @returns Truncated machine identifier suitable for the widget header.
 */
function truncateMachineId(machineId: string): string {
  return machineId.length <= 18 ? machineId : `${machineId.slice(0, 8)}...${machineId.slice(-8)}`;
}

interface StatusWidgetState {
  copyFeedback: CopyFeedbackState;
  copyMachineId: () => Promise<void>;
  extensions: ExtensionInfo[];
  machineId: string | null;
}

/**
 * Load and subscribe to the current machine identity.
 * @returns Current machine ID, or `null` while unavailable.
 */
function useMachineIdState(): string | null {
  const bus = useBus();
  const runIdRef = useRef(0);
  const [machineId, setMachineId] = useState<string | null>(null);

  useEffect(() => {
    const currentRunId = ++runIdRef.current;
    const isCurrentRun = (): boolean => runIdRef.current === currentRunId;

    const loadMachineId = async (): Promise<void> => {
      try {
        const { machineId: nextMachineId } = await bus.request(KernelSubjects.isReady, {});
        if (isCurrentRun()) {
          setMachineId(nextMachineId);
        }
      } catch (error) {
        if (isCurrentRun()) {
          console.error('[StatusWidget] Failed to load runtime status', error);
        }
      }
    };

    void loadMachineId();

    return () => {
      ++runIdRef.current;
    };
  }, [bus]);

  return machineId;
}

/**
 * Load and subscribe to extension state when the current widget size needs it.
 * @param enabled - Whether extension state should be loaded for the active size.
 * @returns Extension list used by medium/large layouts.
 */
function useExtensionState(enabled: boolean): ExtensionInfo[] {
  const bus = useBus();
  const runIdRef = useRef(0);
  const loadedExtensionsRef = useRef(false);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);

  useEffect(() => {
    if (!enabled) {
      loadedExtensionsRef.current = false;
      setExtensions([]);
      return;
    }

    const currentRunId = ++runIdRef.current;
    const isCurrentRun = (): boolean => runIdRef.current === currentRunId;

    const loadExtensions = async (): Promise<void> => {
      try {
        const { extensions: nextExtensions } = await bus.request(ExtensionSubjects.list, {});

        if (!isCurrentRun()) {
          return;
        }

        loadedExtensionsRef.current = true;
        setExtensions(nextExtensions);
      } catch (error) {
        if (isCurrentRun()) {
          console.error('[StatusWidget] Failed to load extension status', error);
        }
      }
    };

    const refreshExtensions = (): void => {
      void loadExtensions();
    };

    const unsubscribe = bus.on(ExtensionSubjects.stateChanged, (ctx) => {
      setExtensions((current) => {
        if (!loadedExtensionsRef.current) {
          // Recover from a cold-cache miss by reloading the authoritative list.
          refreshExtensions();
          return current;
        }

        const existing = current.find((extension) => extension.name === ctx.payload.name);
        if (!existing) {
          // State changes for extensions that were not in the last snapshot mean
          // the local cache is stale; refresh instead of silently dropping them.
          refreshExtensions();
          return current;
        }

        const next = current.filter((extension) => extension.name !== ctx.payload.name);
        next.push({
          browser: existing.browser,
          displayName: ctx.payload.displayName,
          enabled: existing.enabled,
          error: ctx.payload.error,
          name: ctx.payload.name,
          state: ctx.payload.to,
          surface: existing.surface,
        });
        return next.sort((left, right) => left.displayName.localeCompare(right.displayName));
      });
    });

    void loadExtensions();

    return () => {
      ++runIdRef.current;
      loadedExtensionsRef.current = false;
      unsubscribe();
    };
  }, [bus, enabled]);

  return extensions;
}

/**
 * Manage runtime and extension state shown by the framework status widget.
 * @param includeExtensions - Whether the current widget size renders extension state.
 * @returns Machine identity, extension state, and copy helpers for the widget UI.
 */
function useStatusWidgetState(includeExtensions: boolean): StatusWidgetState {
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const machineId = useMachineIdState();
  const extensions = useExtensionState(includeExtensions);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedbackState>('idle');

  const scheduleCopyFeedbackReset = (): void => {
    if (copyFeedbackTimerRef.current !== null) {
      clearTimeout(copyFeedbackTimerRef.current);
    }

    copyFeedbackTimerRef.current = setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopyFeedback('idle');
    }, COPY_FEEDBACK_TIMEOUT_MS);
  };
  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
    },
    [],
  );

  const copyMachineId = async (): Promise<void> => {
    if (!machineId || typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyFeedback('error');
      scheduleCopyFeedbackReset();
      return;
    }

    try {
      await navigator.clipboard.writeText(machineId);
      setCopyFeedback('success');
      scheduleCopyFeedbackReset();
    } catch (error) {
      setCopyFeedback('error');
      scheduleCopyFeedbackReset();
      console.error('[StatusWidget] Failed to copy machine ID', error);
    }
  };

  return { copyFeedback, copyMachineId, extensions, machineId };
}

interface RuntimeSectionProps {
  copyFeedback: CopyFeedbackState;
  copyMachineId: () => Promise<void>;
  machineId: string | null;
}

/**
 * Render runtime identity and copy-state feedback.
 * @param props - Machine identity plus copy-state handlers.
 * @returns Runtime section of the status widget.
 */
function RuntimeSection(props: RuntimeSectionProps): JSX.Element {
  const { copyFeedback, copyMachineId, machineId } = props;
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel}>Runtime</span>
      <button
        className={styles.machineIdButton}
        disabled={!machineId}
        onClick={machineId ? () => void copyMachineId() : undefined}
        title={machineId ? 'Copy machine ID' : 'Machine ID unavailable'}
        type="button"
      >
        {machineId ? truncateMachineId(machineId) : 'Machine ID unavailable'}
      </button>
      {copyFeedback === 'success' ? (
        <span aria-live="polite" className={styles.feedbackSuccess}>
          Copied machine ID.
        </span>
      ) : null}
      {copyFeedback === 'error' ? (
        <span aria-live="polite" className={styles.feedbackError}>
          Failed to copy machine ID.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Render one extension state card.
 * @param props - Extension record to render.
 * @returns Extension status card.
 */
function ExtensionCard(props: { extension: ExtensionInfo }): JSX.Element {
  const { extension } = props;
  return (
    <div className={styles.extensionCard}>
      <div className={styles.extensionHeader}>
        <span>{extension.displayName}</span>
        <span className={styles.extensionStatus}>
          <span className={styles.statusDot} style={{ backgroundColor: STATUS_DOT_STYLE[extension.state] }} />
          {extension.state}
        </span>
      </div>
      {extension.error ? <span className={styles.extensionError}>{extension.error}</span> : null}
    </div>
  );
}

/**
 * Render the extension-status section of the widget.
 * @param props - Current extension list.
 * @returns Extension list section.
 */
function ExtensionsSection(props: { extensions: ExtensionInfo[] }): JSX.Element {
  const { extensions } = props;
  return (
    <div className={styles.extensionsSection}>
      <span className={styles.sectionLabel}>Extensions</span>
      <div className={styles.extensionsList}>
        {extensions.length === 0 ? (
          <div className={styles.emptyExtensions}>No extensions registered.</div>
        ) : (
          extensions.map((extension) => <ExtensionCard extension={extension} key={extension.name} />)
        )}
      </div>
    </div>
  );
}

/**
 * Render the disabled runtime restart affordance placeholder.
 * @returns Disabled restart button.
 */
function RestartRuntimeButton(): JSX.Element {
  return (
    <button className={styles.restartButton} disabled title="Not yet available" type="button">
      Restart Runtime
    </button>
  );
}

/**
 * Compact summary of extension states shown at medium size.
 * @param props - Current extension list.
 * @returns Inline status summary with counts per state.
 */
function ExtensionsSummary(props: { extensions: ExtensionInfo[] }): JSX.Element {
  const { extensions } = props;
  const counts = new Map<ExtensionInfo['state'], number>();
  for (const ext of extensions) {
    counts.set(ext.state, (counts.get(ext.state) ?? 0) + 1);
  }

  if (extensions.length === 0) {
    return <span className={styles.summaryText}>No extensions registered.</span>;
  }

  const parts: string[] = [];
  const active = counts.get('active') ?? 0;
  if (active > 0) parts.push(`${active} active`);
  const failed = counts.get('failed') ?? 0;
  if (failed > 0) parts.push(`${failed} failed`);
  const other = extensions.length - active - failed;
  if (other > 0) parts.push(`${other} other`);

  return (
    <div className={styles.summaryRow}>
      <span className={styles.sectionLabel}>Extensions</span>
      <span className={styles.summaryText}>{parts.join(', ')}</span>
      {failed > 0 ? <span className={styles.statusDot} style={{ backgroundColor: 'var(--color-danger)' }} /> : null}
    </div>
  );
}

/**
 * Single-line compact status row for the tray surface.
 *
 * Renders a green status dot, the "Running" label, and the first 7 characters
 * of the machine ID for at-a-glance identification.
 * @param props - Machine identity to abbreviate.
 * @returns Compact single-line status row.
 */
function CompactStatusRow(props: { machineId: string | null }): JSX.Element {
  const { machineId } = props;
  const idPrefix = machineId ? machineId.slice(0, 7) : '…';
  return (
    <div className={styles.compactRow} data-testid="status-compact-row">
      <span className={styles.statusDot} style={{ backgroundColor: 'var(--color-success)' }} />
      <span className={styles.compactLabel}>Running</span>
      <span className={styles.compactMachineId}>{idPrefix}</span>
    </div>
  );
}

/**
 * Built-in widget that surfaces runtime and extension lifecycle state.
 *
 * Adapts its content to the current widget size:
 * - `small` — single-line tray row: green dot, "Running", machine-ID prefix.
 * - `medium` — compact: machine ID, extension summary counts, restart button.
 * - `large` / `full-width` — full: machine ID, scrollable extension list, restart button.
 * @param props - Standard widget props including current size.
 * @returns Framework status widget content.
 */
function StatusWidget(props: WidgetProps): JSX.Element {
  const { size } = props;
  const isCompact = size === 'medium';
  const includeExtensions = size !== 'small';
  const { copyFeedback, copyMachineId, extensions, machineId } = useStatusWidgetState(includeExtensions);

  if (size === 'small') {
    return (
      <div className={styles.widget} data-component="StatusWidget" data-size={size}>
        <CompactStatusRow machineId={machineId} />
      </div>
    );
  }

  return (
    <div className={styles.widget} data-component="StatusWidget" data-size={size}>
      <RuntimeSection copyFeedback={copyFeedback} copyMachineId={copyMachineId} machineId={machineId} />
      {isCompact ? <ExtensionsSummary extensions={extensions} /> : <ExtensionsSection extensions={extensions} />}
      <RestartRuntimeButton />
    </div>
  );
}

/**
 * Framework-owned built-in widget definition that surfaces runtime and extension state.
 *
 * Register this definition by passing it as a `builtIn` to {@link useWidgets} so it
 * is available in the dashboard palette and can be placed on any global-scope canvas.
 */
export const frameworkStatusWidgetDefinition: WidgetDefinition = {
  allowMultiple: false,
  component: StatusWidget,
  defaultSize: 'large',
  description: 'Runtime and extension health for the framework shell.',
  id: 'framework-status',
  name: 'Status',
  scope: ['global', 'tray'],
  supportedSizes: ['small', 'medium', 'large', 'full-width'],
  trayDefaultSize: 'small',
};
