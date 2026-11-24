import { describe, expect, it } from "vitest";
import { applyTuningParams } from "@/engine";
import { buildPresentQuery, layoutForScene, parsePresentParams, parseSceneList, PRESENT_DEFAULTS, PRESENTER_TUNING } from "./params";

describe("/present URL parameters", () => {
  it("no parameters: the documented defaults (transparent, bottom, 2 lines, 6 s, controls on)", () => {
    expect(parsePresentParams("")).toEqual(PRESENT_DEFAULTS);
    expect(PRESENT_DEFAULTS).toEqual({ device: "", size: 56, lines: 2, align: "bottom", bg: "transparent", full: [], clearSec: 6, controls: true });
  });

  it("reads every parameter", () => {
    const p = parsePresentParams("device=BlackHole%202ch&size=72&lines=3&align=top&bg=dark&full=Captions+Only|Q%26A&clear=10&controls=0");
    expect(p).toEqual({ device: "BlackHole 2ch", size: 72, lines: 3, align: "top", bg: "dark", full: ["Captions Only", "Q&A"], clearSec: 10, controls: false });
  });

  it("clamps numbers, ignores junk, and never throws on odd values", () => {
    expect(parsePresentParams("size=5&lines=99&clear=9999")).toMatchObject({ size: 16, lines: 6, clearSec: 120 });
    expect(parsePresentParams("size=9999")).toMatchObject({ size: 220 });
    expect(parsePresentParams("size=abc&lines=&clear=NaN")).toMatchObject({ size: 56, lines: 2, clearSec: 6 });
    expect(parsePresentParams("align=middle&bg=red&controls=yes")).toMatchObject({ align: "bottom", bg: "transparent", controls: true });
    expect(parsePresentParams("clear=0").clearSec).toBe(0); // 0 = never clear
    expect(parsePresentParams("clear=-3").clearSec).toBe(0);
    expect(parsePresentParams("device=" + "x".repeat(500)).device).toHaveLength(120);
  });

  it("scene lists split on | or , and trim", () => {
    expect(parseSceneList("A | B,C ,, ")).toEqual(["A", "B", "C"]);
    expect(parseSceneList(null)).toEqual([]);
    expect(parseSceneList("")).toEqual([]);
  });

  it("buildPresentQuery writes only what differs from the defaults, and round-trips", () => {
    expect(buildPresentQuery({})).toBe("");
    expect(buildPresentQuery(PRESENT_DEFAULTS)).toBe("");
    const want = { device: "CABLE Output", size: 80, lines: 3, align: "center" as const, bg: "dark" as const, full: ["Captions Only", "Q&A"], clearSec: 0, controls: false };
    const q = buildPresentQuery(want, { profile: "chapter", fin: "3000", empty: "  " });
    expect(parsePresentParams(q)).toEqual(want);
    expect(new URLSearchParams(q).get("profile")).toBe("chapter");
    expect(new URLSearchParams(q).get("fin")).toBe("3000");
    expect(new URLSearchParams(q).has("empty")).toBe(false);
  });
});

describe("per-scene layout (?full=)", () => {
  it("is 'full' only for the listed scenes, ignoring case and spaces; strip otherwise", () => {
    const full = ["Captions Only", "Q&A"];
    expect(layoutForScene("Captions Only", full)).toBe("full");
    expect(layoutForScene("  q&a ", full)).toBe("full");
    expect(layoutForScene("Slides + Camera", full)).toBe("strip");
    expect(layoutForScene("Captions Only 2", full)).toBe("strip"); // exact name, not a prefix
  });
  it("is the strip when OBS never told us the scene, or no scenes are listed", () => {
    expect(layoutForScene(null, ["A"])).toBe("strip");
    expect(layoutForScene("A", [])).toBe("strip");
  });
});

describe("presenter tuning for /present", () => {
  it("is the measured set, with forced Finalize OFF", () => {
    expect(PRESENTER_TUNING).toMatchObject({ endpointingMs: 300, contextPhrases: 3, finalizeMs: 0 });
    expect(PRESENTER_TUNING.segmenter).toMatchObject({ maxWords: 14, maxAgeMs: 4000, pauseMs: 350, quietMs: 600, holdMs: 1000 });
  });
  it("the URL still overrides it: ?fin= turns Finalize on, ?max= changes max words, the rest stay presenter values", () => {
    const t = applyTuningParams(PRESENTER_TUNING, "fin=3000&max=20");
    expect(t.finalizeMs).toBe(3000);
    expect(t.segmenter.maxWords).toBe(20);
    expect(t.endpointingMs).toBe(300);
    expect(t.segmenter.quietMs).toBe(600);
    expect(applyTuningParams(PRESENTER_TUNING, "").finalizeMs).toBe(0);
  });
});
