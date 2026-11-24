/** Full-page navigation (drops all client state; used after login and on session expiry). */
export function hardNavigate(path: string) {
  window.location.href = path;
}

/**
 * Where to go after login: only a path on this site. Anything else (another origin, a protocol-relative "//host", a
 * backslash trick, a scheme, control characters, an absurd length) falls back to the home page, so the login form cannot be
 * used to send someone elsewhere.
 */
export function safeNext(raw: string | null | undefined, fallback = "/"): string {
  if (!raw || raw.length > 2000) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const u = new URL(raw, "http://x.invalid");
    if (u.origin !== "http://x.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/**
 * What to do when the server says the session is gone (a 401). The default sends the browser to the login page, which is
 * right for a person at a screen and wrong for a caption overlay on a live stream: /present installs its own handler that
 * only records the fact (the login page must never be drawn on air).
 */
let authLostHandler: () => void = () => hardNavigate("/");

export function authLost() {
  authLostHandler();
}

/** Replaces the 401 behaviour; returns a function that restores the previous one. */
export function setAuthLostHandler(fn: () => void): () => void {
  const prev = authLostHandler;
  authLostHandler = fn;
  return () => {
    authLostHandler = prev;
  };
}
