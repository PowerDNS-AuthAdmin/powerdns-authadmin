import { describe, expect, it } from "vitest";
import { evaluateClusterSync } from "./cluster-sync";

describe("evaluateClusterSync — with expected serial", () => {
  it("in-sync when every peer >= expected", () => {
    const r = evaluateClusterSync(
      42,
      new Map([
        ["a", 42],
        ["b", 42],
        ["c", 43],
      ]),
    );
    expect(r.state).toBe("in-sync");
  });

  it("converging when any peer is behind", () => {
    const r = evaluateClusterSync(
      42,
      new Map([
        ["a", 42],
        ["b", 41],
      ]),
    );
    expect(r.state).toBe("converging");
    expect(r.expectedSerial).toBe(42);
  });

  it("converging when a peer is unreachable (null)", () => {
    const r = evaluateClusterSync(
      42,
      new Map([
        ["a", 42],
        ["b", null],
      ]),
    );
    expect(r.state).toBe("converging");
  });
});

describe("evaluateClusterSync — no expected (steady state)", () => {
  it("in-sync when every peer has the same serial", () => {
    const r = evaluateClusterSync(
      null,
      new Map([
        ["a", 10],
        ["b", 10],
        ["c", 10],
      ]),
    );
    expect(r.state).toBe("in-sync");
  });

  it("diverged when peers disagree", () => {
    const r = evaluateClusterSync(
      null,
      new Map([
        ["a", 10],
        ["b", 11],
      ]),
    );
    expect(r.state).toBe("diverged");
  });

  it("diverged when any peer is unreachable", () => {
    const r = evaluateClusterSync(
      null,
      new Map([
        ["a", 10],
        ["b", null],
      ]),
    );
    expect(r.state).toBe("diverged");
  });
});
