/**
 * Markdown rendering for dev publish info comments.
 * @packageDocumentation
 */

import type { DevPublishInfo } from './dev-publish-info.js';

const DEV_PUBLISH_INFO_MARKER = '<!-- makaio-dev-publish-info -->';

/**
 * Creates a Markdown report for dev publish candidates.
 * @param info - Resolved dev publish info.
 * @returns Markdown body suitable for a sticky PR comment.
 */
export function renderDevPublishInfo(info: DevPublishInfo): string {
  const packageNames = info.candidates.map((pkg) => pkg.name);
  const command = packageNames.length > 0 ? `/publish-dev ${packageNames.join(' ')}` : undefined;
  const details =
    info.candidates.length > 0
      ? [
          '<details>',
          '<summary>Mapped publish-relevant files</summary>',
          '',
          ...info.candidates.flatMap((pkg) => [
            `**${pkg.name}**`,
            '',
            '_Changed in this PR_',
            '',
            ...(pkg.prChangedFiles.length > 0 ? pkg.prChangedFiles : ['_none_']).map((file) =>
              file === '_none_' ? '- _none_' : `- \`${file}\``,
            ),
            '',
            '_Pending since latest reachable dev tag_',
            '',
            ...pkg.pendingFiles.map((file) => `- \`${file}\``),
            '',
          ]),
          '</details>',
          '',
        ]
      : [];

  return [
    DEV_PUBLISH_INFO_MARKER,
    '### Dev publish info',
    '',
    `Range: \`${info.baseSha}\`...\`${info.headSha}\``,
    '',
    command ? `Suggested command: \`${command}\`` : 'No pending dev-publishable package changes were found.',
    '',
    '| Package | Signal | Pending files | Latest reachable dev tag |',
    '|---|---|---:|---|',
    ...info.candidates.map((pkg) => {
      const latestTag = pkg.latestTag
        ? `\`${pkg.latestTag}\` (${pkg.latestTagCommit?.slice(0, 7) ?? 'unknown'})`
        : '_none_';
      return `| \`${pkg.name}\` | ${pkg.reason === 'pr' ? 'PR' : 'pending'} | ${pkg.pendingFiles.length} | ${latestTag} |`;
    }),
    '',
    ...details,
  ].join('\n');
}
