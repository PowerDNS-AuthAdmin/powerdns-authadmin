<!--
SECURITY.md - public security policy.

The goal of this file is to give a security researcher a clear, fast path to report a vulnerability
without it leaking to the public issue tracker, and to set expectations on response time and
disclosure.
-->

# Security Policy

## Supported versions

`v1.0.0` is the first production release. Supported versions:

- The latest stable major (`v1.x`) - all security fixes.
- The previous stable major - security fixes only, for 6 months after a new major ships.

Run a current `v1.x` release in production; older tags receive best-effort fixes only.

## Reporting a vulnerability

**Do not** open public GitHub issues for security vulnerabilities.

Instead, use **GitHub's private vulnerability reporting**: navigate to the repository's
_Security_ tab → _Report a vulnerability_. This sends an encrypted report directly to the
maintainers and creates a private draft advisory.

If private reporting is unavailable, email the lead maintainer (contact published on the project
website / GitHub profile) with `[SECURITY]` in the subject line. PGP keys are listed in
`docs/security/pgp-keys.md`.

### What to include

- A description of the vulnerability and its impact.
- Steps to reproduce, including:
  - Versions affected (commit hash, release tag).
  - Configuration relevant to the issue.
  - Whether authentication is required to trigger it.
- Any proof-of-concept code (please do not test against systems you don't own).
- Your name / handle for credit (or "anonymous").

## Response expectations

- **Acknowledgement** within 72 hours.
- **Initial triage** (severity assessment, scope confirmation) within 7 days.
- **Fix or mitigation** target depends on severity:
  - Critical (RCE, auth bypass, data loss): 7 days.
  - High (privilege escalation, sensitive data exposure): 14 days.
  - Medium / Low: 30–60 days.
- **Public disclosure** after a fix is released, with credit unless requested otherwise. We follow
  a 90-day disclosure window from initial report; extensions discussed case-by-case.

## Scope

In scope:

- This repository and all artifacts it produces (the Docker images on Docker Hub).
- Configuration recommendations in `docs/`.

Out of scope:

- PowerDNS itself (please report to https://www.powerdns.com/security).
- Third-party dependencies (please report upstream, but feel free to CC us if it affects our users).
- Social engineering of maintainers or users.

## Hardening recommendations

PowerDNS-AuthAdmin ships secure defaults, but deployment hardening is the operator's responsibility.
A future hardening runbook will cover TLS termination, secret storage, network policies, and
monitoring; until then the documented env defaults + `docs/FEATURES.md` § 17 cover the basics.

## Recognition

We maintain a public list of researchers who have responsibly disclosed vulnerabilities at
`docs/security/credits.md`. By default we credit reporters; you may opt out at report time.

We do not currently offer a monetary bug bounty. We do offer profuse thanks.
