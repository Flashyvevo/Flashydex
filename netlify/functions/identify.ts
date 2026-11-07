const DISCOVERY_URL = "https://flashydex-recognizer.netlify.app/recognizer.json"
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 20_000
const DISCOVERY_CACHE_MS = 60_000

let discoveredUpstream: { url: string; expiresAt: number } | undefined
const requestsByIp = new Map<string, { tokens: number; updatedAt: number }>()

function json(code: string, message: string, retryable: boolean, status: number): Response {
  return Response.json(
    { error: { code, message, retryable } },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}

function clientIp(request: Request): string | undefined {
  return request.headers.get("x-nf-client-connection-ip") ?? request.headers.get("client-ip") ?? undefined
}

function rateLimited(ip: string | undefined): boolean {
  if (!ip) return false
  const now = Date.now()
  const capacity = 12
  const refillPerMs = capacity / 60_000
  const current = requestsByIp.get(ip) ?? { tokens: capacity, updatedAt: now }
  current.tokens = Math.min(capacity, current.tokens + (now - current.updatedAt) * refillPerMs)
  current.updatedAt = now
  if (current.tokens < 1) {
    requestsByIp.set(ip, current)
    return true
  }
  current.tokens -= 1
  requestsByIp.set(ip, current)
  return false
}

async function upstreamBase(): Promise<string> {
  const configured = process.env.FLASHYDEX_RECOG_UPSTREAM?.trim()
  if (configured) return configured
  if (discoveredUpstream && discoveredUpstream.expiresAt > Date.now()) return discoveredUpstream.url

  const response = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`discovery returned ${response.status}`)
  const payload = await response.json() as { url?: unknown }
  if (typeof payload.url !== "string" || !payload.url.startsWith("https://")) {
    throw new Error("discovery returned no HTTPS url")
  }
  discoveredUpstream = { url: payload.url, expiresAt: Date.now() + DISCOVERY_CACHE_MS }
  return payload.url
}

function upstreamUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString()
}

function proxyHeaders(request: Request): Headers {
  const headers = new Headers()
  const contentType = request.headers.get("content-type")
  const token = process.env.FLASHYDEX_RECOG_TOKEN
  if (contentType) headers.set("content-type", contentType)
  if (token) headers.set("authorization", `Bearer ${token}`)
  const ip = clientIp(request)
  if (ip) headers.set("x-fdx-client-ip", ip)
  return headers
}

function mapUpstream(response: Response): Response {
  if (response.status === 401 || response.status === 403) return json("UNAUTHORIZED", "recognizer authentication failed", false, 401)
  if (response.status === 413) return json("PAYLOAD_TOO_LARGE", "image exceeds the upload limit", false, 413)
  if (response.status === 415) return json("UNSUPPORTED_IMAGE", "this image format is not supported", false, 415)
  if (response.status === 429) return json("RATE_LIMITED", "too many recognition requests", true, 429)
  if (response.status === 503) return json("RECOGNIZER_BUSY", "the scanner is busy — try again in a moment", true, 503)
  if (response.status >= 500) return json("RECOGNIZER_OFFLINE", "the scanner is offline", true, 502)
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  })
}

export default async function identify(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } })
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return json("PAYLOAD_TOO_LARGE", "image exceeds the 6 MB upload limit", false, 413)
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return json("UNSUPPORTED_IMAGE", "multipart/form-data with an image part is required", false, 415)
  }
  if (rateLimited(clientIp(request))) {
    return json("RATE_LIMITED", "too many recognition requests", true, 429)
  }

  try {
    const upstream = await upstreamBase()
    const response = await fetch(upstreamUrl(upstream, "/v1/identify"), {
      method: "POST",
      headers: proxyHeaders(request),
      body: request.body,
      // Node requires this when forwarding a request stream.
      duplex: "half",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    } as RequestInit)
    return mapUpstream(response)
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return json("RECOGNIZER_TIMEOUT", "the scanner did not respond in time", true, 504)
    }
    return json("RECOGNIZER_OFFLINE", "the scanner is offline", true, 502)
  }
}
