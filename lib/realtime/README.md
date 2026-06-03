## lib/realtime

Realtime and background coordination: SSE event bus, backend health refreshes,
zone-state polling, replication drift tracking, Redis fan-out, and startup-mode
logging.

This directory coordinates ongoing work. It should call domain/repository
helpers rather than embedding route-specific authorization or UI behavior.
