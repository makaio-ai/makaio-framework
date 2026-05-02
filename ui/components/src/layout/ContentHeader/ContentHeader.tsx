import styles from './ContentHeader.module.scss';
import type { ContentHeaderProps } from './types.js';

/**
 * ContentHeader component
 *
 * Reusable page header with title and action buttons.
 * Displays title, optional subtitle, and action buttons on the right.
 * @example
 * ```tsx
 * <ContentHeader
 *   title="Widgets"
 *   subtitle="Manage your widgets"
 *   actions={[
 *     <HeaderTextAction key="add" onClick={handleAdd}>Add Widget</HeaderTextAction>,
 *     <HeaderIconAction key="edit" icon={<EditIcon />} label="Edit mode" active={isEditMode} />,
 *   ]}
 * />
 * ```
 * @param props - Component props
 * @returns The rendered header component
 */
export function ContentHeader({ title, subtitle, actions, className }: ContentHeaderProps) {
  const rootClassNames = [styles.header, className].filter(Boolean).join(' ');

  return (
    <header data-component="ContentHeader" className={rootClassNames}>
      <div className={styles.titleSection}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
