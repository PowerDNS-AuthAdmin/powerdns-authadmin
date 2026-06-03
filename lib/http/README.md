## lib/http

Shared HTTP response helpers for route handlers, including typed-error to
status-code mapping.

Routes still own authentication, authorization, CSRF checks, validation, and
audit logging before they call these helpers.
