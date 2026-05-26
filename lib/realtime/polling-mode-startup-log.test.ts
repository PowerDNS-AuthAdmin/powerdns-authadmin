/**
 * lib/realtime/polling-mode-startup-log.test.ts
 *
 * Three branches of the boot-time hint + the 3 s probe budget + the
 * one-shot guard. Mocks: env (the flag), db (the topology probe), logger
 * (so we can assert on the line that landed). Each `it()` does
 * `vi.resetModules()` + re-mocks so the module-level `hasRun` latch
 * starts fresh per test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const loggerMocks = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@/lib/logger", () => ({ logger: loggerMocks }));

// Default DB shape — every test overrides if it needs different topology.
const dbMocks = {
  select: vi.fn(),
};
vi.mock("@/lib/db", () => ({ db: dbMocks }));

vi.mock("@/lib/db/schema", () => ({
  pdnsServers: {},
  pdnsClusters: {},
}));

vi.mock("@/lib/pdns/capabilities", () => ({
  isReadOnlyMirror: (caps: { primary?: boolean; secondary?: boolean } | null) =>
    !!caps && caps.secondary === true && caps.primary !== true,
  isWriteCapable: (caps: { primary?: boolean; secondary?: boolean } | null) =>
    !caps || !(caps.secondary === true && caps.primary !== true),
}));

interface ServerRow {
  disabledAt: Date | null;
  capabilities: { primary?: boolean; secondary?: boolean } | null;
}

function stubDb(servers: ServerRow[], clusters: Array<{ id: string }>): void {
  // First select() → servers; second → clusters. Match the call order in
  // polling-mode-startup-log.ts.
  let call = 0;
  dbMocks.select.mockImplementation(() => {
    const which = call++;
    return {
      from: () => Promise.resolve(which === 0 ? servers : clusters),
    };
  });
}

async function loadModule(pollingEnabled: boolean) {
  vi.resetModules();
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.error.mockClear();
  dbMocks.select.mockReset();
  vi.doMock("@/lib/env", () => ({
    pdnsBackgroundPollingEnabled: pollingEnabled,
    env: {},
  }));
  return await import("./polling-mode-startup-log");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("logPollingModeOnce", () => {
  it("info-logs that polling is ON and features are enabled when the flag is true", async () => {
    const mod = await loadModule(true);
    await mod.logPollingModeOnce();
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    const msg = String(loggerMocks.info.mock.calls[0]![0]);
    expect(msg).toContain("PDNS_BACKGROUND_POLLING=true");
    expect(msg).toContain("ENABLED");
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("info-logs single-server / standalone mode when flag is false and no replication topology exists", async () => {
    const mod = await loadModule(false);
    stubDb([{ disabledAt: null, capabilities: { primary: false, secondary: false } }], []);
    await mod.logPollingModeOnce();
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    const msg = String(loggerMocks.info.mock.calls[0]![0]);
    expect(msg).toContain("PDNS_BACKGROUND_POLLING=false");
    expect(msg.toLowerCase()).toContain("standalone");
  });

  it("warns when flag is false but the configured fleet HAS replication topology (mirrors)", async () => {
    const mod = await loadModule(false);
    stubDb(
      [
        { disabledAt: null, capabilities: { primary: true, secondary: false } },
        { disabledAt: null, capabilities: { primary: false, secondary: true } }, // a mirror
      ],
      [],
    );
    await mod.logPollingModeOnce();
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).not.toHaveBeenCalled();
    const call = loggerMocks.warn.mock.calls[0] as [unknown, unknown];
    const meta = call[0] as { mirrors: number };
    const msg = call[1];
    expect(String(msg)).toContain("PDNS_BACKGROUND_POLLING=false");
    expect(String(msg)).toContain("PDNS_BACKGROUND_POLLING=true");
    expect(meta).toMatchObject({ mirrors: 1 });
  });

  it("warns when flag is false but a configured cluster is present (no mirrors yet)", async () => {
    const mod = await loadModule(false);
    stubDb(
      [{ disabledAt: null, capabilities: { primary: true, secondary: false } }],
      [{ id: "cluster-1" }],
    );
    await mod.logPollingModeOnce();
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    const meta = loggerMocks.warn.mock.calls[0]![0] as { clusters: number };
    expect(meta.clusters).toBe(1);
  });

  it("silently gives up if the topology probe takes longer than the 3s budget", async () => {
    vi.useFakeTimers();
    const mod = await loadModule(false);
    // db.select returns a from() whose Promise NEVER resolves — simulates a
    // hung Postgres. We expect logPollingModeOnce to resolve cleanly without
    // logging anything (info or warn) once the 3 s timer fires.
    dbMocks.select.mockReturnValue({
      from: () => new Promise(() => undefined),
    });
    const p = mod.logPollingModeOnce();
    await vi.advanceTimersByTimeAsync(3_500);
    await p;
    expect(loggerMocks.info).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("is one-shot: a second call is a no-op even if topology changed in between", async () => {
    const mod = await loadModule(false);
    stubDb([{ disabledAt: null, capabilities: { primary: false, secondary: false } }], []);
    await mod.logPollingModeOnce();
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);

    // Same module instance — second call must not log again.
    await mod.logPollingModeOnce();
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });
});
