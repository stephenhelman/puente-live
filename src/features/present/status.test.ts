import { describe, expect, it } from "vitest";
import { statusLight } from "./status";

const ok = { authLost: false, deviceMissing: false, offline: false, source: "live" as const, paused: false, starting: false };

describe("statusLight", () => {
  it("green while listening", () => expect(statusLight(ok)).toEqual({ key: "listening", color: "green" }));
  it("amber while paused, starting or reconnecting", () => {
    expect(statusLight({ ...ok, paused: true })).toEqual({ key: "paused", color: "amber" });
    expect(statusLight({ ...ok, source: "off", starting: true })).toEqual({ key: "starting", color: "amber" });
    expect(statusLight({ ...ok, source: "reconnecting" })).toEqual({ key: "reconnecting", color: "amber" });
  });
  it("red when a person has to act, and the worst condition wins", () => {
    expect(statusLight({ ...ok, source: "failed" }).color).toBe("red");
    expect(statusLight({ ...ok, offline: true }).key).toBe("offline");
    expect(statusLight({ ...ok, deviceMissing: true, paused: true }).key).toBe("no-device");
    expect(statusLight({ ...ok, authLost: true, deviceMissing: true, source: "failed" }).key).toBe("signed-out");
  });
  it("a paused session that is also reconnecting shows the reconnect (the socket matters more than the pause)", () => {
    expect(statusLight({ ...ok, paused: true, source: "reconnecting" }).key).toBe("reconnecting");
  });
});
