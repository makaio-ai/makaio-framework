# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Makaio Framework, please report
it responsibly. **Do not open a public GitHub issue.**

Email **security@makaio.com** with:

- A description of the vulnerability
- Steps to reproduce or a proof of concept
- The affected component (e.g., bus transport, adapter, storage)
- Your assessment of severity and impact

## What to Expect

- **Acknowledgement** within 48 hours
- **Initial assessment** within 7 days
- We will coordinate a fix and disclosure timeline with you before any public
  announcement
- Credit will be given to reporters unless they prefer to remain anonymous

## Scope

The following components are in scope for security reports:

- **Bus transport** — WebSocket authentication (HMAC, E2E encryption), relay
- **Adapter layer** — credential handling, subprocess spawning
- **Storage** — SQLite access, migration runner
- **Extension system** — descriptor loading, path containment, entrypoint validation
- **CLI / Desktop hosts** — command injection, privilege escalation

General bugs that are not security-relevant should be reported as
[GitHub issues](https://github.com/makaio-ai/makaio-framework/issues).
