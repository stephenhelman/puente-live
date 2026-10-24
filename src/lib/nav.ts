/** Full-page navigation (drops all client state; used after login and on session expiry). */
export function hardNavigate(path: string) {
  window.location.href = path;
}
