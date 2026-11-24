import { describe, expect, it } from "vitest";
import { matchDevice, type AudioInputInfo } from "./inputDevice";

const d = (deviceId: string, label: string): AudioInputInfo => ({ deviceId, label });

describe("matchDevice: picking the virtual cable by name", () => {
  const mac = [d("default", "Default - MacBook Pro Microphone"), d("a1", "MacBook Pro Microphone"), d("b2", "BlackHole 2ch"), d("c3", "Zoom Audio Device")];

  it("matches a part of the label, case-insensitively", () => {
    expect(matchDevice(mac, "blackhole")?.deviceId).toBe("b2");
    expect(matchDevice(mac, "BLACKHOLE 2")?.deviceId).toBe("b2");
  });
  it("returns null when nothing matches, or the name is empty", () => {
    expect(matchDevice(mac, "VB-Cable")).toBeNull();
    expect(matchDevice(mac, "")).toBeNull();
    expect(matchDevice(mac, "   ")).toBeNull();
    expect(matchDevice([], "x")).toBeNull();
  });
  it("prefers an exact label, then a prefix, then a substring", () => {
    const list = [d("1", "Cable Output (old)"), d("2", "CABLE Output"), d("3", "Virtual CABLE Output 2")];
    expect(matchDevice(list, "cable output")?.deviceId).toBe("2");
    expect(matchDevice(list, "cable")?.deviceId).toBe("1"); // both 1 and 2 start with it: the first one
    expect(matchDevice(list, "virtual")?.deviceId).toBe("3");
  });
  it("never picks the browser's 'default' alias when a real device matches (it can point at a microphone)", () => {
    const win = [d("default", "Default - CABLE Output (VB-Audio Virtual Cable)"), d("communications", "Communications - CABLE Output (VB-Audio Virtual Cable)"), d("w9", "CABLE Output (VB-Audio Virtual Cable)")];
    expect(matchDevice(win, "CABLE Output")?.deviceId).toBe("w9");
  });
  it("uses an alias only when it is all there is", () => {
    expect(matchDevice([d("default", "Default - CABLE Output")], "cable")?.deviceId).toBe("default");
  });
  it("cannot match unlabelled devices (the caller then shows the list)", () => {
    expect(matchDevice([d("x", ""), d("y", "")], "blackhole")).toBeNull();
  });
});
