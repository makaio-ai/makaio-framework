import type { ReactNode } from 'react';
import { useCallback } from 'react';
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type Layout,
  type LayoutChangedMeta,
  type LayoutStorage,
} from 'react-resizable-panels';
import type { Pane, SplitPane as SplitPaneType, PaneContent } from './types.js';
import styles from './SplitPane.module.scss';

/**
 * Props for the SplitPane component.
 */
export interface SplitPaneProps {
  /**
   * The root pane to render (can be a leaf or split pane).
   */
  root: Pane;

  /**
   * Callback to render content for a leaf pane.
   * @param content - The content descriptor for the pane
   * @param paneId - The unique ID of the pane
   * @returns The rendered content
   */
  renderContent: (content: PaneContent, paneId: string) => ReactNode;

  /**
   * Optional auto-save ID for persisting layout state.
   */
  autoSaveId?: string;

  /**
   * Optional callback when panel sizes change after user resize.
   * @param sizes - Array of panel sizes as percentages
   */
  onLayoutChange?: (sizes: number[]) => void;

  /**
   * Optional CSS class name for custom styling.
   */
  className?: string;
}

const noopStorage: LayoutStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

/**
 * Convert a numeric percentage to a percent string for react-resizable-panels.
 * @param value - Percentage value (0-100)
 * @returns Percent string or undefined
 */
function toPercent(value?: number): string | undefined {
  if (value === undefined) return undefined;
  return `${value}%`;
}

interface SplitPaneGroupProps {
  pane: SplitPaneType;
  rootId: string;
  renderContent: (content: PaneContent, paneId: string) => ReactNode;
  autoSaveId?: string;
  onLayoutChange?: (sizes: number[]) => void;
}

/**
 * SplitPane component - Recursive layout renderer using react-resizable-panels.
 *
 * This component renders a workspace layout tree with support for:
 * - Horizontal and vertical splits
 * - Resizable panes with drag handles
 * - Nested layouts (splits within splits)
 * - Auto-save layout state to localStorage
 * - Leaf panes with custom content rendering
 *
 * The component is pure UI - it takes a layout tree and a render function,
 * and handles the visual presentation and user interactions (resize).
 * State management and content rendering are delegated to the parent.
 * @param props - Component props
 * @returns The rendered SplitPane component
 * @example
 * ```tsx
 * const layout: Pane = {
 *   type: 'split',
 *   id: 'root',
 *   direction: 'horizontal',
 *   sizes: [30, 70],
 *   children: [
 *     { type: 'leaf', id: 'sidebar', content: { type: 'view', viewId: 'nav' } },
 *     { type: 'leaf', id: 'main', content: { type: 'view', viewId: 'editor' } },
 *   ],
 * };
 *
 * <SplitPane
 *   root={layout}
 *   renderContent={(content, paneId) => <MyView content={content} />}
 *   autoSaveId="workspace-layout"
 * />
 * ```
 */
export function SplitPane({ root, renderContent, autoSaveId, onLayoutChange, className }: SplitPaneProps): ReactNode {
  if (root.type === 'leaf') {
    return (
      <div data-component="SplitPane" className={className ? `${styles.splitPane} ${className}` : styles.splitPane}>
        <div className={styles.leafPane}>{renderContent(root.content, root.id)}</div>
      </div>
    );
  }

  return (
    <div data-component="SplitPane" className={className ? `${styles.splitPane} ${className}` : styles.splitPane}>
      <SplitPaneGroup
        pane={root}
        rootId={root.id}
        renderContent={renderContent}
        autoSaveId={autoSaveId}
        onLayoutChange={onLayoutChange}
      />
    </div>
  );
}

/**
 * Renders a split pane group with resize persistence.
 * @param props - Split pane group props
 * @returns Rendered group
 */
function SplitPaneGroup(props: SplitPaneGroupProps): ReactNode {
  const { pane, rootId, renderContent, autoSaveId, onLayoutChange } = props;
  const groupId = autoSaveId ? `${autoSaveId}-${pane.id}` : pane.id;
  const panelIds = pane.children.map((child) => child.id);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: groupId,
    panelIds,
    storage: autoSaveId ? undefined : noopStorage,
  });

  const handleLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      onLayoutChanged(layout, meta);
      if (onLayoutChange && pane.id === rootId) {
        const sizes = pane.children.map((child) => layout[child.id] ?? 0);
        onLayoutChange(sizes);
      }
    },
    [onLayoutChange, onLayoutChanged, pane.children, pane.id, rootId],
  );

  return (
    <Group
      id={groupId}
      orientation={pane.direction}
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
    >
      {pane.children.flatMap((child, index) => {
        const size = pane.sizes[index];
        const constraints = child.constraints;

        const elements = [
          <Panel
            key={child.id}
            id={child.id}
            className={styles.panel}
            defaultSize={toPercent(constraints?.defaultSize ?? size)}
            minSize={toPercent(constraints?.minSize)}
            maxSize={toPercent(constraints?.maxSize)}
            collapsible={constraints?.collapsible}
          >
            <SplitPaneNode
              pane={child}
              rootId={rootId}
              renderContent={renderContent}
              autoSaveId={autoSaveId}
              onLayoutChange={onLayoutChange}
            />
          </Panel>,
        ];

        if (index < pane.children.length - 1) {
          elements.push(<Separator key={`handle-${child.id}`} className={styles.resizeHandle} />);
        }

        return elements;
      })}
    </Group>
  );
}

interface SplitPaneNodeProps {
  pane: Pane;
  rootId: string;
  renderContent: (content: PaneContent, paneId: string) => ReactNode;
  autoSaveId?: string;
  onLayoutChange?: (sizes: number[]) => void;
}

/**
 * Renders a single pane node (leaf or nested group).
 * @param props - Split pane node props
 * @returns Rendered pane
 */
function SplitPaneNode(props: SplitPaneNodeProps): ReactNode {
  const { pane, rootId, renderContent, autoSaveId, onLayoutChange } = props;
  if (pane.type === 'leaf') {
    return <div className={styles.leafPane}>{renderContent(pane.content, pane.id)}</div>;
  }

  return (
    <SplitPaneGroup
      pane={pane}
      rootId={rootId}
      renderContent={renderContent}
      autoSaveId={autoSaveId}
      onLayoutChange={onLayoutChange}
    />
  );
}
