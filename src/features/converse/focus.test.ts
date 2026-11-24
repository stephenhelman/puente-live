import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FOCUS_GROW, paneRole } from "./focus";

const css = readFileSync("src/features/converse/converse.module.css", "utf8");
const half = readFileSync("src/features/converse/Half.tsx", "utf8");

describe("pane roles", () => {
  it("idle: both halves are idle; while a side speaks it is the speaker and the other the listener", () => {
    expect(paneRole(null, "en")).toBe("idle");
    expect(paneRole(null, "es")).toBe("idle");
    expect(paneRole("en", "en")).toBe("speaker");
    expect(paneRole("en", "es")).toBe("listener");
    expect(paneRole("es", "es")).toBe("speaker");
    expect(paneRole("es", "en")).toBe("listener");
  });
  it("a quarter for the speaker, three quarters for the listener", () => {
    expect(FOCUS_GROW.listener / (FOCUS_GROW.listener + FOCUS_GROW.speaker)).toBe(0.75);
    expect(FOCUS_GROW.idle).toBe(FOCUS_GROW.speaker); // idle is the even split
  });
});

describe("the layout CSS keeps the promises (guards against an accidental edit)", () => {
  it("mirrors FOCUS_GROW: listener 3, speaker 1, idle 1", () => {
    expect(css).toMatch(/\.pane\[data-role="listener"\]\s*\{\s*flex-grow:\s*3;/);
    expect(css).toMatch(/\.pane\[data-role="speaker"\]\s*\{\s*flex-grow:\s*1;/);
    expect(css).toMatch(/\.pane\s*\{[^}]*flex:\s*1 1 0;/);
  });
  it("animates in 200 ms and honours reduced motion", () => {
    expect(css).toMatch(/\.pane\s*\{[^}]*transition:\s*flex-grow \.2s/);
    const reduced = css.slice(css.indexOf("prefers-reduced-motion: reduce"));
    expect(reduced).toMatch(/\.pane,[^{]*\{\s*transition:\s*none;/);
  });
  it("the controls row has the same height in every state, so text above it never shifts when a pane resizes", () => {
    expect(css).toMatch(/\.controls\s*\{[^}]*flex:\s*0 0 var\(--controls-h\)/);
    expect(css).not.toMatch(/\.(speaker|listener) \.controls/);
  });
  it("the speaking half gives its room to the speaker's live words: notices are hidden there, errors are not", () => {
    expect(css).toMatch(/\.speaker \.notice\s*\{\s*display:\s*none;/);
    expect(css).not.toMatch(/\.speaker \.error\s*\{[^}]*display:\s*none/);
  });
  it("the bar keeps the disclaimer on its own full-width row, so the extra glossary control cannot squeeze it on a phone", () => {
    expect(css).toMatch(/\.bar\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.disclaimer\s*\{\s*flex:\s*1 1 100%/);
    expect(css).toMatch(/\.profile\s*\{\s*flex:\s*1\.1 1 0;\s*min-width:\s*0/); // the glossary and Clear controls share row 2
    expect(css).toMatch(/\.half \.small\s*\{\s*flex:\s*1 1 0;\s*min-width:\s*0/);
  });
  it("the top half stays rotated 180 degrees", () => {
    expect(css).toMatch(/\.rotated\s*\{\s*transform:\s*rotate\(180deg\);/);
  });
  it("the translation's font size never depends on how much text has arrived (no size steps while someone reads)", () => {
    expect(css).not.toMatch(/\.long\b|\.xlong\b/);
    expect(half).not.toMatch(/sizeClass|styles\.long|styles\.xlong/);
  });
  it("text sizes are viewport-based, so a pane changing height does not re-wrap the text", () => {
    for (const rule of [".theirs", ".own"]) {
      const m = css.match(new RegExp(`${rule.replace(".", "\\.")}\\s*\\{[^}]*font-size:\\s*([^;]+);`));
      expect(m?.[1], rule).toMatch(/vmin/);
    }
  });
});
