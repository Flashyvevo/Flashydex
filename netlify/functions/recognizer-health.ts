const DISCOVERY_URL = "https://flashydex-recognizer.netlify.app/recognizer.json"
const DISCOVERY_CACHE_MS = 60_000

let discoveredUpstream: { url: string; expiresAt: number } | undefined

function offline(status = 502): Response {
  return Response.json(
    { ok: false, indexCounts: {}, version: null, latencyMs: null },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}

async function upstreamBase(): Promise<string> {
  const configured = process.env.FLASHYDEX_RECOG_UPSTREAM?.trim()
  if (configured) return configured
  if (discoveredUpstream && discoveredUpstream.expiresAt > Date.now()) return discoveredUpstream.url
  const response = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`discovery returned ${response.status}`)
  const payload = await response.json() as { url?: unknown }
  if (typeof payload.url !== "string" || !payload.url.startsWith("https://")) throw new Error("invalid discovery payload")
  discoveredUpstream = { url: payload.url, expiresAt: Date.now() + DISCOVERY_CACHE_MS }
  return payload.url
}

export default async function health(request: Request): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } })
  try {
    const base = await upstreamBase()
    const start = performance.now()
    const response = await fetch(new URL("/v1/health", base.endsWith("/") ? base : `${base}/`), {
      headers: { authorization: `Bearer ${process.env.FLASHYDEX_RECOG_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return offline(response.status === 401 ? 502 : 503)
    const payload = await response.json() as { status?: string; index?: { counts?: Record<string, number> }; version?: string; indexVersion?: string }
    return Response.json({
      ok: payload.status === "ok",
      indexCounts: payload.index?.counts ?? {},
      version: payload.indexVersion ?? payload.version ?? null,
      latencyMs: Math.round(performance.now() - start),
    }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return offline()
  }
}
