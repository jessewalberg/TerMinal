// Bounded request-body reader for webhook payloads. GitLab pipeline JSON is
// tiny; the cap prevents accidental memory exhaustion from malformed clients.

export const MAX_BODY_BYTES = 256 * 1024

export type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; error: 'too_large' | 'read_failed' }

/** Read at most maxBytes from a fetch Request body (streaming, no full-buffer first). */
export async function readBodyLimited(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<ReadBodyResult> {
  if (!req.body) return { ok: true, text: '' }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, error: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, error: 'read_failed' }
  }

  const merged = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(merged) }
}
