<!--
A good PR description is the difference between a 10-minute review and a 60-minute one.
Fill out each section honestly. If a section doesn't apply, write "n/a" — don't leave it blank.
-->

## What and why

<!-- One paragraph: what changes, and what problem it solves. Link the issue this closes:
     "Closes #123" / "Fixes #456" / "Related to #789". -->

Closes #

## How

<!-- Bullet the implementation approach. Call out non-obvious choices.
     If you considered an alternative and rejected it, mention why. -->

-

## Tests

<!-- What did you add? What's the regression test for the bug being fixed? -->

-

## Threat-modeling

<!-- REQUIRED for any change touching auth, RBAC, sessions, the PDNS client, or the public API.
     One paragraph: what could go wrong, what stops it. Delete this section if not applicable. -->

n/a

## Documentation

<!-- New ADR in `docs/adr/`? Updated `docs/FEATURES.md`? New env var documented in `.env.example`? -->

-

## Checklist

- [ ] PR title uses Conventional Commits (`feat:`, `fix:`, `docs:`, …)
- [ ] Linked issue exists and is approved (no "I had a free afternoon" PRs)
- [ ] `npm run validate` passes locally (lint + typecheck + format + test)
- [ ] New code is documented (file-level + JSDoc on exports)
- [ ] No secrets in code, config, logs, or fixture data
- [ ] If user-visible: strings go through i18n (or PR opens an i18n follow-up)
