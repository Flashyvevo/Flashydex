// Run: node --test netlify/tests/   (Node >= 22.18 strips TS types natively)
// Lives outside netlify/functions/ on purpose: Netlify deploys every file in that directory as a function.
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test } from "node:test"

import identify, {
  MAX_UPLOAD_BYTES,
  bucketRetryAfter,
  mapUpstreamError,
  multipartBoundary,
  parseRetryAfter,
  readCapped,
  validateMultipart,
} from "../functions/identify.ts"

const B = "----fdxboundary"
const CT = `multipart/form-data; boundary=${B}`

function part(name: string, body: string | Uint8Array = "x", filename?: string): Buffer {
  const head = `--${B}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n\r\n`
  return Buffer.concat([Buffer.from(head), Buffer.from(body), Buffer.from("\r\n")])
}
const END = Buffer.from(`--${B}--\r\n`)
const form = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, END])
const goodForm = (imageBytes = 100): Buffer => form(part("lang", "en"), part("image", Buffer.alloc(imageBytes, 0xab), "card.jpg"))

function streamOf(buf: Buffer, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= buf.length) return controller.close()
      controller.enqueue(new Uint8Array(buf.subarray(offset, offset + chunk)))
      offset += chunk
    },
  })
}

function request(body: Buffer, headers: Record<string, string> = {}): Request {
  // no Content-Length unless the caller supplies one; the body is a stream
  return new Request("https://flashydex.test/api/identify", {
    method: "POST",
    headers: { "content-type": CT, ...headers },
    body: streamOf(body),
    duplex: "half",
  } as RequestInit)
}

describe("parseRetryAfter", () => {
  test("accepts delay-seconds, rejects junk", () => {
    assert.equal(parseRetryAfter("58"), 58)
    assert.equal(parseRetryAfter(" 1 "), 1)
    assert.equal(parseRetryAfter("0"), 0)
    for (const bad of [null, undefined, "", "-1", "1.5", "abc", "Wed, 21 Oct 2026 07:28:00 GMT", "999999", "1e3"]) {
      assert.equal(parseRetryAfter(bad as string | null), undefined, String(bad))
    }
  })
})

describe("mapUpstreamError (S10-03 / S10-04)", () => {
  test("429 keeps a validated Retry-After", () => {
    const spec = mapUpstreamError(429, "RATE_LIMITED", "58")
    assert.deepEqual(spec, { code: "RATE_LIMITED", message: spec?.message, retryable: true, status: 429, retryAfter: 58 })
    assert.equal(mapUpstreamError(429, null, "garbage")?.retryAfter, undefined)
  })
  test("BUSY only for the concurrency rejection, with Retry-After", () => {
    const busy = mapUpstreamError(503, "RECOGNIZER_BUSY", "1")
    assert.equal(busy?.code, "RECOGNIZER_BUSY")
    assert.equal(busy?.status, 503)
    assert.equal(busy?.retryAfter, 1)
    assert.equal(mapUpstreamError(503, "BUSY", null)?.code, "RECOGNIZER_BUSY")
  })
  test("INDEX_NOT_READY / MODEL_MISSING keep their upstream code with HTTP 503, never BUSY", () => {
    for (const code of ["INDEX_NOT_READY", "MODEL_MISSING"]) {
      const spec = mapUpstreamError(503, code, null)
      assert.equal(spec?.code, code)
      assert.equal(spec?.status, 503)
      assert.equal(spec?.retryable, true)
    }
  })
  test("unknown / unparseable 503 and 5xx are offline (502), not busy", () => {
    assert.equal(mapUpstreamError(503, null, null)?.code, "RECOGNIZER_OFFLINE")
    assert.equal(mapUpstreamError(503, "SOMETHING", "5")?.status, 502)
    assert.equal(mapUpstreamError(500, null, null)?.code, "RECOGNIZER_OFFLINE")
    assert.equal(mapUpstreamError(502, null, null)?.status, 502)
  })
  test("auth, size, type mapping and passthrough", () => {
    assert.equal(mapUpstreamError(401, null, null)?.code, "UNAUTHORIZED")
    assert.equal(mapUpstreamError(403, null, null)?.status, 401)
    assert.equal(mapUpstreamError(413, null, null)?.code, "PAYLOAD_TOO_LARGE")
    assert.equal(mapUpstreamError(415, null, null)?.code, "UNSUPPORTED_IMAGE")
    assert.equal(mapUpstreamError(400, "INVALID_IMAGE", null), undefined)
    assert.equal(mapUpstreamError(200, null, null), undefined)
  })
})

describe("local bucket Retry-After", () => {
  test("emits a Retry-After >= 1 once the bucket is empty, and recovers", () => {
    const ip = "198.51.100.77"
    const t0 = 1_000_000
    for (let i = 0; i < 12; i++) assert.equal(bucketRetryAfter(ip, t0), undefined)
    const wait = bucketRetryAfter(ip, t0)
    assert.ok(wait !== undefined && wait >= 1 && wait <= 5, String(wait)) // 12/min refill => ~5 s per token
    assert.equal(bucketRetryAfter(ip, t0 + 6_000), undefined)
    assert.equal(bucketRetryAfter(undefined), undefined)
  })
})

describe("readCapped (S10-06)", () => {
  test("counts streamed bytes without Content-Length and aborts past the cap", async () => {
    const ok = await readCapped(streamOf(Buffer.alloc(1000)), 1000)
    assert.equal(ok.length, 1000)
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    await assert.rejects(readCapped(endless, 256 * 1024), { name: "Error" })
    assert.ok(pulled < 10, `read stopped early (pulled ${pulled} chunks)`)
  })
})

describe("validateMultipart (S10-06)", () => {
  test("one image part passes (with or without extra fields)", () => {
    assert.equal(validateMultipart(goodForm(), CT), undefined)
    assert.equal(validateMultipart(form(part("image", "abc", "a.jpg")), CT), undefined)
  })
  test("missing image part is rejected", () => {
    assert.equal(validateMultipart(form(part("lang", "en")), CT)?.code, "INVALID_IMAGE")
    assert.equal(validateMultipart(form(part("file", "abc")), CT)?.status, 400)
  })
  test("duplicate image parts are rejected", () => {
    assert.equal(validateMultipart(form(part("image", "a"), part("image", "b")), CT)?.code, "INVALID_IMAGE")
  })
  test("garbage, unterminated or boundary-less bodies are rejected", () => {
    assert.equal(validateMultipart(Buffer.from("not multipart"), CT)?.code, "INVALID_IMAGE")
    assert.equal(validateMultipart(Buffer.concat([part("image", "a")]), CT)?.code, "INVALID_IMAGE") // no closing delimiter
    assert.equal(validateMultipart(goodForm(), "multipart/form-data")?.code, "INVALID_IMAGE")
  })
  test("boundary parsing handles quotes", () => {
    assert.equal(multipartBoundary('multipart/form-data; boundary="a b-c"'), "a b-c")
    assert.equal(multipartBoundary(CT), B)
    assert.equal(multipartBoundary(null), undefined)
  })
  test("a binary image containing a fake 'name=\"image\"' header text does not count as a second part", () => {
    const sneaky = Buffer.from('Content-Disposition: form-data; name="image"\r\n\r\n')
    assert.equal(validateMultipart(form(part("image", sneaky, "a.jpg")), CT), undefined)
  })
})

describe("identify() end to end with a mocked upstream", () => {
  const realFetch = globalThis.fetch
  let calls: Array<{ url: string; headers: Headers; bytes: number }> = []
  let reply: () => Response = () => Response.json({ status: "match" })

  beforeEach(() => {
    calls = []
    process.env.FLASHYDEX_RECOG_UPSTREAM = "https://upstream.test"
    process.env.FLASHYDEX_RECOG_TOKEN = "secret-token"
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as Uint8Array | undefined
      calls.push({ url: String(input), headers: new Headers(init?.headers), bytes: body?.byteLength ?? 0 })
      return reply()
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("valid upload with no Content-Length is forwarded with the bearer", async () => {
    const res = await identify(request(goodForm(5000), { "x-nf-client-connection-ip": "203.0.113.1" }))
    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://upstream.test/v1/identify")
    assert.equal(calls[0].headers.get("authorization"), "Bearer secret-token")
    assert.equal(calls[0].headers.get("x-fdx-client-ip"), "203.0.113.1")
  })

  test("streamed body over 6 MiB (no Content-Length) is 413 and never reaches the upstream", async () => {
    const big = form(part("image", Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 1), "big.jpg"))
    const res = await identify(request(big, { "x-nf-client-connection-ip": "203.0.113.2" }))
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error.code, "PAYLOAD_TOO_LARGE")
    assert.equal(calls.length, 0)
  })

  test("boundary overhead counts toward the cap: image just under 6 MiB but body over is 413", async () => {
    const big = form(part("lang", "en"), part("image", Buffer.alloc(MAX_UPLOAD_BYTES - 50, 1), "big.jpg"))
    assert.ok(big.length > MAX_UPLOAD_BYTES)
    const res = await identify(request(big, { "x-nf-client-connection-ip": "203.0.113.3" }))
    assert.equal(res.status, 413)
    assert.equal(calls.length, 0)
  })

  test("declared Content-Length over the cap is 413 immediately", async () => {
    const res = await identify(request(goodForm(), { "content-length": String(MAX_UPLOAD_BYTES + 1), "x-nf-client-connection-ip": "203.0.113.4" }))
    assert.equal(res.status, 413)
  })

  test("duplicate / missing image part is 400 INVALID_IMAGE and never reaches the upstream", async () => {
    for (const bad of [form(part("image", "a"), part("image", "b")), form(part("lang", "en"))]) {
      const res = await identify(request(bad, { "x-nf-client-connection-ip": "203.0.113.5" }))
      assert.equal(res.status, 400)
      assert.equal((await res.json()).error.code, "INVALID_IMAGE")
    }
    assert.equal(calls.length, 0)
  })

  test("upstream 429 + Retry-After survives the proxy", async () => {
    reply = () => new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429, headers: { "retry-after": "58" } })
    const res = await identify(request(goodForm(), { "x-nf-client-connection-ip": "203.0.113.6" }))
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("retry-after"), "58")
    assert.equal((await res.json()).error.code, "RATE_LIMITED")
  })

  test("upstream BUSY / INDEX_NOT_READY / MODEL_MISSING envelopes map to distinct codes", async () => {
    const cases: Array<[string, number, string, string | null]> = [
      ["RECOGNIZER_BUSY", 503, "RECOGNIZER_BUSY", "1"],
      ["INDEX_NOT_READY", 503, "INDEX_NOT_READY", null],
      ["MODEL_MISSING", 503, "MODEL_MISSING", null],
    ]
    for (const [upstream, status, expected, retryAfter] of cases) {
      reply = () => new Response(JSON.stringify({ error: { code: upstream, message: "m", retryable: true } }), {
        status: 503,
        headers: retryAfter ? { "retry-after": retryAfter } : {},
      })
      const res = await identify(request(goodForm(), { "x-nf-client-connection-ip": "203.0.113.7" }))
      assert.equal(res.status, status)
      assert.equal((await res.json()).error.code, expected)
      assert.equal(res.headers.get("retry-after"), retryAfter)
    }
  })

  test("local bucket 429 carries Retry-After", async () => {
    reply = () => Response.json({ status: "match" })
    let last: Response | undefined
    for (let i = 0; i < 14; i++) last = await identify(request(goodForm(), { "x-nf-client-connection-ip": "203.0.113.99" }))
    assert.equal(last?.status, 429)
    assert.ok(Number(last?.headers.get("retry-after")) >= 1)
  })

  test("upstream 400 INVALID_IMAGE passes through unchanged", async () => {
    reply = () => new Response(JSON.stringify({ error: { code: "INVALID_IMAGE", message: "m", retryable: false } }), { status: 400, headers: { "content-type": "application/json" } })
    const res = await identify(request(goodForm(), { "x-nf-client-connection-ip": "203.0.113.8" }))
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, "INVALID_IMAGE")
  })
})
