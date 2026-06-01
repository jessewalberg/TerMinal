// Webhook signature verification for GitHub (HMAC-SHA256) and GitLab (token header).
// GitLab project hooks document X-Gitlab-Token as a shared secret; GitHub uses
// X-Hub-Signature-256. Both are checked with timingSafeEqual.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type VerifyResult = { ok: true } | { ok: false; reason: string }

function safeEq(a: string, b: string): boolean {
  if (!a || !b) return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** GitHub Actions / GitHub webhook: X-Hub-Signature-256: sha256=<hex> */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: 'missing X-Hub-Signature-256' }
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  if (!safeEq(signatureHeader, expected)) return { ok: false, reason: 'bad github signature' }
  return { ok: true }
}

/** GitLab pipeline hook: X-Gitlab-Token matches the configured secret token. */
export function verifyGitlabToken(
  tokenHeader: string | undefined,
  secret: string,
): VerifyResult {
  if (!tokenHeader) return { ok: false, reason: 'missing X-Gitlab-Token' }
  if (!safeEq(tokenHeader, secret)) return { ok: false, reason: 'bad gitlab token' }
  return { ok: true }
}

/** Pick verifier based on which header the sender sent. */
export function verifyWebhookSignature(
  rawBody: string,
  headers: { github?: string; gitlab?: string },
  secret: string,
): VerifyResult {
  if (headers.github) return verifyGithubSignature(rawBody, headers.github, secret)
  if (headers.gitlab) return verifyGitlabToken(headers.gitlab, secret)
  return { ok: false, reason: 'no signature header' }
}
