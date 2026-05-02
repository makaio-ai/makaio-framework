/**
 * Icon component for application-wide use
 *
 * Simple icon renderer using lucide-react icons.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Clipboard,
  Copy,
  Eye,
  GitBranch,
  GitCommit,
  Folder,
  FileDiff,
  Tag,
  ExternalLink,
  File,
  Undo2,
  ChevronRight,
  ChevronDown,
  Monitor,
  Globe,
  List,
} from 'lucide-react';

/**
 * Mapping of icon names to Lucide components.
 *
 * This is the single source of truth for supported icon names — `IconName`
 * is derived from the keys so the union type never drifts out of sync.
 */
const ICON_MAP = {
  clipboard: Clipboard,
  copy: Copy,
  eye: Eye,
  branch: GitBranch,
  'git-branch': GitBranch,
  commit: GitCommit,
  'git-commit': GitCommit,
  folder: Folder,
  diff: FileDiff,
  tag: Tag,
  'external-link': ExternalLink,
  file: File,
  revert: Undo2,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  monitor: Monitor,
  globe: Globe,
  list: List,
} satisfies Record<string, LucideIcon>;

/**
 * Supported icon names, derived from `ICON_MAP` to stay in sync automatically.
 */
export type IconName = keyof typeof ICON_MAP;

/**
 * Props for the Icon component.
 */
export interface IconProps {
  name: IconName;
  className?: string;
  size?: number | string;
}

/**
 * Type guard for valid icon names.
 * @param icon - String to check
 * @returns True if icon is a valid IconName
 */
export function isIconName(icon: string): icon is IconName {
  return Object.hasOwn(ICON_MAP, icon);
}

/**
 * Renders an icon from a string name.
 *
 * Falls back to null if icon not found.
 * @param props - Icon props
 * @returns Icon element or null
 */
export function Icon({ name, className, size = 16 }: IconProps) {
  const Component = ICON_MAP[name];

  if (!Component) {
    console.warn(`Icon not found: ${name}`);
    return null;
  }

  return <Component data-component="Icon" className={className} size={size} />;
}
