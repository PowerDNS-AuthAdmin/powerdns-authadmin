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
website / GitHub profile) with `[SECURITY]` in the subject line. There is no published PGP key
at the moment; use GitHub's private reporting if the report is sensitive enough to need
encryption in transit.

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

- This repository and all artifacts it produces (the container images on
  `ghcr.io/powerdns-authadmin/powerdns-authadmin` and the signed release assets).
- Configuration recommendations in `docs/`.

Out of scope:

- PowerDNS itself (please report to https://www.powerdns.com/security).
- Third-party dependencies (please report upstream, but feel free to CC us if it affects our users).
- Social engineering of maintainers or users.

## Hardening recommendations

PowerDNS-AuthAdmin ships secure defaults, but deployment hardening is the operator's responsibility.
[`docs/08-HARDENING.md`](./docs/08-HARDENING.md) is the checklist (TLS termination, secret
storage, network exposure, MFA, image-signature verification); `docs/FEATURES.md` § 17 lists
the built-in security posture.

## Recognition

Researchers who responsibly disclose a vulnerability are credited in the GitHub security advisory
and in the `CHANGELOG.md` entry for the fix. By default we credit reporters; you may opt out at
report time.

We do not currently offer a monetary bug bounty. We do offer profuse thanks.
