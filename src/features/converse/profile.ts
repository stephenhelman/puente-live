import { DEFAULT_PROFILE, parseProfile, type GlossaryProfile } from "@/engine";

/** /converse is used for bleeding-disorder events, so its glossary starts as the hemophilia profile. */
export const DEFAULT_CONVERSE_PROFILE: GlossaryProfile = "hemophilia";
export const PROFILE_KEY = "puente.converse.profile";

type Store = Pick<Storage, "getItem" | "setItem">;

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage blocked
  }
}

/** The profile the person chose on this device. Null when none, an unknown value, or storage is blocked. */
export function readSavedProfile(s: Pick<Store, "getItem"> | null = store()): GlossaryProfile | null {
  try {
    return parseProfile(s?.getItem(PROFILE_KEY) ?? null);
  } catch {
    return null;
  }
}

export function saveProfile(p: GlossaryProfile, s: Pick<Store, "setItem"> | null = store()): void {
  try {
    s?.setItem(PROFILE_KEY, p);
  } catch {
    /* storage full or blocked: the choice lasts until the page closes */
  }
}

/** `?profile=` beats the saved choice, which beats the default. `fromUrl` tells the UI the setting is locked by the address. */
export function resolveProfile(urlValue: string | null, saved: GlossaryProfile | null): { profile: GlossaryProfile; fromUrl: boolean } {
  const fromUrl = parseProfile(urlValue);
  if (fromUrl) return { profile: fromUrl, fromUrl: true };
  return { profile: saved ?? DEFAULT_CONVERSE_PROFILE, fromUrl: false };
}

export { DEFAULT_PROFILE };
