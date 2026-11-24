import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERSE_PROFILE, PROFILE_KEY, readSavedProfile, resolveProfile, saveProfile } from "./profile";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const throwing = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("conversation glossary profile", () => {
  it("defaults to hemophilia", () => {
    expect(DEFAULT_CONVERSE_PROFILE).toBe("hemophilia");
    expect(resolveProfile(null, null)).toEqual({ profile: "hemophilia", fromUrl: false });
  });
  it("a saved choice beats the default", () => {
    expect(resolveProfile(null, "chapter")).toEqual({ profile: "chapter", fromUrl: false });
  });
  it("?profile= beats the saved choice, and locks the setting", () => {
    expect(resolveProfile("hemophilia", "chapter")).toEqual({ profile: "hemophilia", fromUrl: true });
    expect(resolveProfile("chapter", "hemophilia")).toEqual({ profile: "chapter", fromUrl: true });
  });
  it("an unknown ?profile= is ignored (never trusted), falling back to the saved choice", () => {
    expect(resolveProfile("admin", "chapter")).toEqual({ profile: "chapter", fromUrl: false });
    expect(resolveProfile("", null)).toEqual({ profile: "hemophilia", fromUrl: false });
    expect(resolveProfile("Hemophilia", null).fromUrl).toBe(false); // names are exact
  });

  it("saves and reads the choice from localStorage", () => {
    const s = memory();
    expect(readSavedProfile(s)).toBeNull();
    saveProfile("chapter", s);
    expect(s.m.get(PROFILE_KEY)).toBe("chapter");
    expect(readSavedProfile(s)).toBe("chapter");
  });
  it("ignores a stored value that is not a known profile", () => {
    const s = memory();
    s.setItem(PROFILE_KEY, "something-else");
    expect(readSavedProfile(s)).toBeNull();
  });
  it("never throws when storage is blocked or full (private mode, quota): reads give null, writes are ignored", () => {
    expect(() => readSavedProfile(throwing)).not.toThrow();
    expect(readSavedProfile(throwing)).toBeNull();
    expect(() => saveProfile("chapter", throwing)).not.toThrow();
    expect(readSavedProfile(null)).toBeNull();
    expect(() => saveProfile("chapter", null)).not.toThrow();
  });
});
