## lib/errors

Error-adjacent helpers that do not belong in the root `lib/errors.ts` typed
error hierarchy, currently secret redaction tests and utilities.

Use `lib/errors.ts` for application error classes. Use this directory for
supporting utilities that keep errors safe to log or return.
