## components/realtime

Client components that subscribe to realtime events and render live status in
the app chrome.

Keep browser subscription and display logic here. Event production and polling
coordination belong under `lib/realtime`.

- `realtime-provider.tsx` opens the single `/api/realtime` EventSource and fans events out to
  `useRealtimeEvent` subscribers. It also owns liveness: `reconnect-policy.ts` decides, from
  the stream's readyState and the time since the last heartbeat, when the provider must
  discard the EventSource and open a new one (frozen tabs, dropped NATs, a browser retry that
  never completes). A reopen after a gap dispatches `realtime.reconnected` so pages refetch.
- `header-status-chip.tsx` renders the connection and fleet sync verdict in the top bar.
