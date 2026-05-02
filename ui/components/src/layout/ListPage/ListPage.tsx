/**
 * ListPage component
 *
 * A composition of Page + ContentHeader + Panel for entity list/browse pages.
 * Provides consistent layout structure for pages like Projects, Sessions, Prompts, etc.
 */

import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Page } from '../Page/Page.js';
import { ContentHeader } from '../ContentHeader/ContentHeader.js';
import type { HeaderActionElement } from '../ContentHeader/types.js';
import { Panel } from '../../primitives/Panel/Panel.js';
import styles from './ListPage.module.scss';

/**
 * Props for ListPage component
 */
export interface ListPageProps {
  /** Page title displayed in the header */
  title: string;

  /** Optional subtitle below the title */
  subtitle?: string;

  /** Action elements for the header (HeaderTextAction or HeaderIconAction) */
  actions?: HeaderActionElement[];

  /** Page content (typically a grid of cards or list) */
  children: ReactNode;

  /** Additional className for the root Page element */
  className?: string;

  /** Additional className for the content Panel */
  contentClassName?: string;

  /**
   * Whether to show the content in a Panel with glass styling.
   * Set to false for custom content containers.
   * Defaults to true.
   */
  usePanel?: boolean;
}

/**
 * ListPage component - standardized layout for entity list pages.
 *
 * Composes Page, ContentHeader, and Panel into a consistent structure
 * for browsing entities (Projects, Sessions, Prompts, Personas, Profiles, etc.).
 * @example
 * ```tsx
 * <ListPage
 *   title="Prompts"
 *   subtitle="Reusable prompt templates"
 *   actions={[
 *     <Input key="search" leftIcon={<Search />} placeholder="Search..." />,
 *     <HeaderTextAction key="create" onClick={handleCreate}>Create</HeaderTextAction>,
 *   ]}
 * >
 *   <div className={styles.grid}>
 *     {prompts.map((p) => <PromptCard key={p.id} {...p} />)}
 *   </div>
 * </ListPage>
 * ```
 * @param props - Component props
 * @returns The rendered list page
 */
export function ListPage({
  title,
  subtitle,
  actions,
  children,
  className,
  contentClassName,
  usePanel = true,
}: ListPageProps) {
  return (
    <Page className={className}>
      <ContentHeader title={title} subtitle={subtitle} actions={actions} />
      {usePanel ? (
        <Panel className={contentClassName} fullHeight>
          {children}
        </Panel>
      ) : (
        <div className={clsx(styles.content, contentClassName)}>{children}</div>
      )}
    </Page>
  );
}
