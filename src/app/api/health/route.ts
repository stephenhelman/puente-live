export const dynamic = "force-dynamic";

/** Railway healthcheck. Public on purpose; returns no configuration or secrets. */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
