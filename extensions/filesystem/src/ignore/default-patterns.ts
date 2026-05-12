/**
 * Default deny patterns applied to all projects.
 * Users can negate these with `!pattern` in `.makaioignore`.
 */
export const DEFAULT_DENIED_PATTERNS: readonly string[] = [
  // Environment and secrets
  '.env',
  '.env.*',

  // Private keys and certificates
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.jks',

  // SSH
  '**/.ssh/**',
  '**/.ssh/id_*',
  '**/id_rsa',
  '**/id_dsa',
  '**/.ssh/known_hosts',
  '**/.ssh/config',

  // GPG
  '**/.gnupg/**',

  // Cloud credentials
  '**/.aws/credentials',
  '**/.azure/credentials',
  '**/.gcloud/**/*.json',

  // Package manager tokens
  '**/.npmrc',
  '.npmrc',
  '**/.pypirc',
  '.pypirc',
  '**/.docker/config.json',
  '**/.netrc',
  '**/pip/pip.conf',
  '**/.venv/**',
  '**/venv/**',
  '**/credentials',
  '**/*-credentials.*',
] as const;
