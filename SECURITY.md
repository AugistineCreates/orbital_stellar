# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |

Pre-release tags (`-alpha`, `-beta`, `-rc`) receive fixes only for critical vulnerabilities.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private advisory system:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the details — what you found, how to reproduce it, and the impact.

We will acknowledge your report within **72 hours** and aim to ship a fix within **14 days** for critical issues. You will be credited in the release notes unless you prefer otherwise.

## Scope

In scope:
- `packages/pulse-core` — SSE stream handling, event normalization
- `packages/pulse-webhooks` — HMAC signing, delivery, SSRF protections
- `packages/pulse-notify` — React hooks
- `apps/server` — API key validation, auth middleware, rate limiting

Out of scope:
- Vulnerabilities in third-party dependencies (report upstream; open a Dependabot advisory here if you want to track it)
- Issues that require physical access to the server
- Denial-of-service against the Stellar network itself

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will publish a GitHub Security Advisory with full details. We ask reporters to wait until the advisory is public before writing about or sharing the vulnerability.
