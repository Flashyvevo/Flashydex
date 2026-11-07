const DISCOVERY_URL = "https://flashydex-recognizer.netlify.app/recognizer.json"
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 20_000
const DISCOVERY_CACHE_MS = 60_000
const MAX_RETRY_AFTER_S = 24 * 60 * 60
const MAX_UPSTREAM_ERROR_BYTES = 4096
const BUCKET_CAPACITY = 12
const BUCKET_REFILL_PER_MS = BUCKET_CAPACITY / 60_000

let discoveredUpstream: { url: string; expiresAt: number } | undefined
const requestsByIp = new Map<string, { tokens: number; updatedAt: number }>()

export type ErrorSpec = { code: string; message: string; retryable: boolean; status: number; retryAfter?: number }

function json(spec: ErrorSpec): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" }
  if (spec.retryAfter !== undefined) headers["Retry-After"] = String(spec.retryAfter)
  return Response.json(
    { error: { code: spec.code, message: spec.message, retryable: spec.retryable } },
    { status: spec.status, headers },
  )
}

function clientIp(request: Request): string | undefined {
  return request.headers.get("x-nf-client-connection-ip") ?? request.headers.get("client-ip") ?? undefined
}

/** A Retry-After value in whole seconds (RFC 9110 delay-seconds form only), or undefined when absent/invalid. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (!/^\d{1,6}$/.test(trimmed)) return undefined
  const seconds = Number(trimmed)
  return seconds <= MAX_RETRY_AFTER_S ? seconds : undefined
}

/** Best-effort per-instance token bucket. Returns the Retry-After (seconds, >= 1) when limited, else undefined. */
export function bucketRetryAfter(ip: string | undefined, now = Date.now()): number | undefined {
  if (!ip) return undefined
  const current = requestsByIp.get(ip) ?? { tokens: BUCKET_CAPACITY, updatedAt: now }
  current.tokens = Math.min(BUCKET_CAPACITY, current.tokens + (now - current.updatedAt) * BUCKET_REFILL_PER_MS)
  current.updatedAt = now
  if (current.tokens < 1) {
    requestsByIp.set(ip, current)
    return Math.max(1, Math.ceil((1 - current.tokens) / BUCKET_REFILL_PER_MS / 1000))
  }
  current.tokens -= 1
  requestsByIp.set(ip, current)
  return undefined
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

/**
 * Pure mapping of an upstream error (HTTP status + the service's `{error:{code}}` code if parseable +
 * its Retry-After header) to the client contract; undefined = pass the response through.
 * RECOGNIZER_BUSY is reserved for the concurrency rejection. INDEX_NOT_READY / MODEL_MISSING keep their
 * upstream code (the client maps them to index/model-unavailable) with HTTP 503.
 */
export function mapUpstreamError(status: number, upstreamCode: string | null, retryAfterHeader: string | null): ErrorSpec | undefined {
  const retryAfter = parseRetryAfter(retryAfterHeader)
  const withRetry = (spec: ErrorSpec): ErrorSpec => (retryAfter === undefined ? spec : { ...spec, retryAfter })
  if (status === 401 || status === 403) {
    return { code: "UNAUTHORIZED", message: "recognizer authentication failed", retryable: false, status: 401 }
  }
  if (status === 413) return { code: "PAYLOAD_TOO_LARGE", message: "image exceeds the upload limit", retryable: false, status: 413 }
  if (status === 415) return { code: "UNSUPPORTED_IMAGE", message: "this image format is not supported", retryable: false, status: 415 }
  if (status === 429) return withRetry({ code: "RATE_LIMITED", message: "too many recognition requests", retryable: true, status: 429 })
  if (status === 503) {
    if (upstreamCode === "RECOGNIZER_BUSY" || upstreamCode === "BUSY") {
      return withRetry({ code: "RECOGNIZER_BUSY", message: "the scanner is busy — try again in a moment", retryable: true, status: 503 })
    }
    if (upstreamCode === "INDEX_NOT_READY") {
      return withRetry({ code: "INDEX_NOT_READY", message: "the scanner is still loading its card index", retryable: true, status: 503 })
    }
    if (upstreamCode === "MODEL_MISSING") {
      return withRetry({ code: "MODEL_MISSING", message: "the scanner model is unavailable", retryable: true, status: 503 })
    }
    return { code: "RECOGNIZER_OFFLINE", message: "the scanner is offline", retryable: true, status: 502 }
  }
  if (status >= 500) return { code: "RECOGNIZER_OFFLINE", message: "the scanner is offline", retryable: true, status: 502 }
  return undefined
}

async function upstreamErrorCode(response: Response): Promise<string | null> {
  try {
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < MAX_UPSTREAM_ERROR_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      total += value.byteLength
    }
    void reader.cancel().catch(() => undefined)
    const code = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: unknown } })?.error?.code
    return typeof code === "string" ? code : null
  } catch {
    return null
  }
}

async function mapUpstream(response: Response): Promise<Response> {
  const code = response.status === 503 ? await upstreamErrorCode(response) : null
  const spec = mapUpstreamError(response.status, code, response.headers.get("retry-after"))
  if (spec) return json(spec)
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  })
}

export class UploadTooLarge extends Error {}

/** Read the request body counting streamed bytes; cancels the stream and throws once `limit` is exceeded. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      void reader.cancel().catch(() => undefined)
      throw new UploadTooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export function multipartBoundary(contentType: string | null): string | undefined {
  const match = /;\s*boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType ?? "")
  return match?.[1] ?? match?.[2]
}

/** Field name of every part (only the section headers after each boundary delimiter are parsed); undefined if malformed/unterminated. */
export function multipartPartNames(body: Buffer, boundary: string): string[] | undefined {
  const delimiter = Buffer.from(`--${boundary}`)
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`)
  const names: string[] = []
  let at = body.indexOf(delimiter)
  while (at >= 0) {
    const after = at + delimiter.length
    if (body.subarray(after, after + 2).toString("latin1") === "--") return names
    const headersEnd = body.indexOf("\r\n\r\n", after)
    if (headersEnd < 0) return undefined
    const headerText = body.subarray(after, headersEnd).toString("latin1")
    names.push(/content-disposition:[^\r\n]*?;\s*name="([^"]*)"/i.exec(headerText)?.[1] ?? "")
    at = body.indexOf(nextDelimiter, headersEnd + 4)
    if (at >= 0) at += 2
  }
  return undefined
}

/** undefined when the body is multipart/form-data with exactly one `image` part; otherwise the error to send. */
export function validateMultipart(body: Buffer, contentType: string | null): ErrorSpec | undefined {
  const boundary = multipartBoundary(contentType)
  const names = boundary ? multipartPartNames(body, boundary) : undefined
  if (!names) return { code: "INVALID_IMAGE", message: "the upload is not a valid multipart form", retryable: false, status: 400 }
  if (names.filter((name) => name === "image").length !== 1) {
    return { code: "INVALID_IMAGE", message: "exactly one image part is required", retryable: false, status: 400 }
  }
  return undefined
}

const TOO_LARGE: ErrorSpec = { code: "PAYLOAD_TOO_LARGE", message: "image exceeds the 6 MB upload limit", retryable: false, status: 413 }

export default async function identify(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } })
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) return json(TOO_LARGE)
  const contentType = request.headers.get("content-type")
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    return json({ code: "UNSUPPORTED_IMAGE", message: "multipart/form-data with an image part is required", retryable: false, status: 415 })
  }
  const waitS = bucketRetryAfter(clientIp(request))
  if (waitS !== undefined) {
    return json({ code: "RATE_LIMITED", message: "too many recognition requests", retryable: true, status: 429, retryAfter: waitS })
  }

  let body: Buffer
  try {
    body = await readCapped(request.body)
  } catch (error) {
    if (error instanceof UploadTooLarge) return json(TOO_LARGE)
    return json({ code: "INVALID_IMAGE", message: "the upload could not be read", retryable: false, status: 400 })
  }
  const invalid = validateMultipart(body, contentType)
  if (invalid) return json(invalid)

  try {
    const upstream = await upstreamBase()
    const response = await fetch(upstreamUrl(upstream, "/v1/identify"), {
      method: "POST",
      headers: proxyHeaders(request),
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    return await mapUpstream(response)
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return json({ code: "RECOGNIZER_TIMEOUT", message: "the scanner did not respond in time", retryable: true, status: 504 })
    }
    return json({ code: "RECOGNIZER_OFFLINE", message: "the scanner is offline", retryable: true, status: 502 })
  }
}
