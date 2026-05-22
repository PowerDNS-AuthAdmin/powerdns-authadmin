# ADR 0002 — License under MIT

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jseifeddine

## Context

PowerDNS-AuthAdmin is intended for community self-hosters and multi-team org IT. The license needs
to fit that audience and remove friction for both casual self-hosting and commercial adoption.

## Decision

PowerDNS-AuthAdmin is licensed under the **MIT License**.

## Rationale

- **Maximum permissiveness.** Anyone can copy, modify, distribute, or sell. This matches the
  stated intent of the project's lead.
- **Familiarity.** MIT is the single most-recognized open-source license; contributors don't have
  to read it to understand it.
- **Compatible with downstream use.** Operators integrating PowerDNS-AuthAdmin into their own
  commercial stacks don't need a legal review before deploying.

## Alternatives considered

- **AGPL-3.0.** Strongly protects against a closed commercial fork at the cost of accessibility
  for downstream integrators. Rejected — the goal is broad accessibility, not protection against
  forking.
- **Apache-2.0.** Stronger explicit patent grant than MIT. Reasonable alternative; rejected to
  keep the licensing story as simple as possible. We can upgrade to Apache-2.0 later if the
  patent grant becomes a felt need.
- **BSD-2-Clause / BSD-3-Clause.** Effectively MIT with minor differences. MIT is better known.

## Consequences

- Contributions are accepted under MIT (a Developer Certificate of Origin is sufficient; no CLA).
- Anyone can fork PowerDNS-AuthAdmin into a closed commercial product. We accept this trade-off in
  exchange for accessibility.

## References

- [`LICENSE`](../../LICENSE)
