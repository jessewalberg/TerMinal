// GitLab pipeline webhook payload helpers — pure, testable, no HTTP imports.

export type GitLabPipelinePayload = {
  object_kind?: string
  status?: string
  object_attributes?: { id?: number; ref?: string; status?: string }
  merge_request?: { iid?: number }
}

/** True when this payload should trigger ci-watchdog. */
export function shouldSpawnWatchdog(payload: GitLabPipelinePayload): boolean {
  if (payload.object_kind !== 'pipeline') return false
  const status = payload.status ?? payload.object_attributes?.status
  return status === 'failed'
}

export function extractCiEnv(payload: GitLabPipelinePayload): {
  pipelineId: string
  mrIid: string
  branch: string
} {
  return {
    pipelineId: String(payload.object_attributes?.id ?? ''),
    mrIid: String(payload.merge_request?.iid ?? ''),
    branch: String(payload.object_attributes?.ref ?? ''),
  }
}
