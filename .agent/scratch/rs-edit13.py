import pathlib

p = pathlib.Path("../../packages/schemas/src/recognition.ts")
s = p.read_bytes().decode()
crlf = "\r\n" in s
s = s.replace("\r\n", "\n")
old_codes = s[s.index("export const RecognitionErrorCode"):s.index("export const RecognitionHealth")]
new_codes = '''/** Codes the service itself emits (`.agent/m2-contract.md`); legacy codes kept for older consumers. */
export const RecognitionErrorCode = z.enum([
  'UNAUTHORIZED', 'RATE_LIMITED', 'RECOGNIZER_BUSY', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_IMAGE',
  'INVALID_IMAGE', 'INVALID_LANG', 'INVALID_MAX_CANDIDATES', 'INVALID_REQUEST', 'INDEX_NOT_READY', 'MODEL_MISSING',
  'ORIGIN_NOT_ALLOWED', 'HTTP_ERROR',
  // legacy (pre-M2) spellings
  'IMAGE_TOO_LARGE', 'UNSUPPORTED_IMAGE_TYPE', 'HEIC_UNSUPPORTED', 'BUSY'
]);
/** Codes the Netlify proxy adds on top (service never sends them). */
export const RecognitionProxyErrorCode = z.enum(['RECOGNIZER_OFFLINE', 'RECOGNIZER_TIMEOUT']);
/** Every service error: `{ error: { code, message, retryable } }` (`retryable` optional only for pre-M2 servers). */
export const RecognitionError = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() })
});
export type RecognitionError = z.infer<typeof RecognitionError>;

'''
s = s.replace(old_codes, new_codes)
s = s.replace('''    version: z.string().nullable()
  }),
  error: z.string().nullable()
});''', '''    version: z.string().nullable()
  }),
  error: z.string().nullable(),
  /** M2 additions (optional for older servers). `ready` = both indexes loaded AND model warmed. */
  ready: z.boolean().optional(),
  warm: z.boolean().optional(),
  counts: z.record(z.string(), z.number().int()).optional(),
  catalogVersion: z.string().nullable().optional(),
  indexVersion: z.string().nullable().optional(),
  uptimeSec: z.number().optional(),
  lastIdentifyMs: z.number().nullable().optional()
});
export type RecognitionHealth = z.infer<typeof RecognitionHealth>;''')
if crlf:
    s = s.replace("\n", "\r\n")
p.write_bytes(s.encode())
print("ok")
