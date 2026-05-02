import type { ReactElement, ReactNode, MouseEventHandler } from 'react';

/**
 * Props for text-style header action button
 */
export interface HeaderTextActionProps {
  /** Button text content */
  children: ReactNode;
  /** Click handler */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Disabled state */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * Props for icon-style header action button
 */
export interface HeaderIconActionProps {
  /** Icon element to display */
  icon: ReactNode;
  /** Accessibility label (required) */
  label: string;
  /** Click handler */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Disabled state */
  disabled?: boolean;
  /** Visual active state (e.g., edit mode toggle) */
  active?: boolean;
  /** Additional CSS class */
  className?: string;
}

type HeaderTextActionComponent = typeof import('./HeaderTextAction.js').HeaderTextAction;
type HeaderIconActionComponent = typeof import('./HeaderIconAction.js').HeaderIconAction;

/**
 * Constrained action element types for ContentHeader
 * Only HeaderTextAction and HeaderIconAction elements are allowed
 */
export type HeaderActionElement =
  | ReactElement<HeaderTextActionProps, HeaderTextActionComponent>
  | ReactElement<HeaderIconActionProps, HeaderIconActionComponent>;

/**
 * Props for ContentHeader component
 */
export interface ContentHeaderProps {
  /** Page title displayed on the left */
  title: string;
  /** Optional subtitle below title */
  subtitle?: string;
  /** Action elements (HeaderTextAction or HeaderIconAction only) */
  actions?: HeaderActionElement[];
  /** Additional CSS class */
  className?: string;
}
