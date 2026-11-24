import { describe, expect, it, vi } from "vitest";
import { authLost, safeNext, setAuthLostHandler } from "./nav";

describe("safeNext: where login may send you", () => {
  it("keeps a path on this site, with its query (/present keeps every URL parameter)", () => {
    expect(safeNext("/present?device=BlackHole&size=64&full=Captions+Only%7CQ%26A")).toBe("/present?device=BlackHole&size=64&full=Captions+Only%7CQ%26A");
    expect(safeNext("/present/setup")).toBe("/present/setup");
    expect(safeNext("/meeting?debug=1#x")).toBe("/meeting?debug=1#x");
  });

  it("refuses everything that could leave the site, and falls back", () => {
    for (const bad of [
      "https://evil.example/", "http://evil.example", "//evil.example/x", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)",
      "evil.example", "present", "", "/\u0000x", "/x\ny", "/a\\b", "data:text/html,x",
    ]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe("/");
    }
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined, "/home")).toBe("/home");
    expect(safeNext("/" + "a".repeat(2100))).toBe("/");
  });
});

describe("authLost", () => {
  it("runs the installed handler instead of navigating, and restores the previous one", () => {
    const seen = vi.fn();
    const restore = setAuthLostHandler(seen);
    authLost();
    expect(seen).toHaveBeenCalledTimes(1); // no navigation (there is no window here: navigating would throw)
    restore();
    expect(() => authLost()).toThrow(); // the default handler touches window.location: proof the override was active before
  });
});
