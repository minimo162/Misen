/**
 * Ephemeral user content accepted by the v2 model boundary.
 *
 * Image bytes intentionally have no string/data-URL form here.  The bytes are
 * converted by the AI SDK only while building the provider request and are
 * never part of the persisted ChatMessage contract.
 */
export const AGENT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type AgentImageMediaType = typeof AGENT_IMAGE_MEDIA_TYPES[number]

export interface AgentTextPart {
  type: 'text'
  text: string
}

export interface AgentImagePart {
  type: 'image'
  mediaType: AgentImageMediaType
  image: Uint8Array
  /** Host-computed visual-token estimate used only for bounded Vision runs. */
  estimatedVisualTokens?: number
}

export type AgentUserContent = string | readonly (AgentTextPart | AgentImagePart)[]

function isSupportedMediaType(value: unknown): value is AgentImageMediaType {
  return typeof value === 'string' && (AGENT_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

/** Structural image check used for provider routing before a model call. */
export function containsAgentImage(content: AgentUserContent | undefined): boolean {
  return Array.isArray(content) && content.some((part) => (
    Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === 'image'
  ))
}

/**
 * Validate and snapshot ephemeral content.
 *
 * `expectedText` is supplied for the initial request so the text retained in
 * the session is exactly the text the model receives.  Tool observations are
 * validated without that equality requirement because they are ephemeral
 * follow-up context.
 */
export function normalizeAgentUserContent(content: AgentUserContent, expectedText?: string): AgentUserContent {
  if (typeof content === 'string') {
    if (content.length === 0) throw new Error('userContent には空でないテキストが必要です')
    if (expectedText !== undefined && content !== expectedText) {
      throw new Error('userContent のテキストが userInput と一致しません')
    }
    return content
  }

  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('userContent にはテキストを含む内容が必要です')
  }

  let hasNonEmptyText = false
  let text = ''
  const normalized: Array<AgentTextPart | AgentImagePart> = []
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new Error('userContent のpart形式が不正です')
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new Error('userContent のtextが不正です')
      if (part.text.length > 0) hasNonEmptyText = true
      text += part.text
      normalized.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') {
      if (!isSupportedMediaType(part.mediaType)) {
        throw new Error('userContent の画像形式は PNG / JPEG / WebP だけ対応しています')
      }
      if (!(part.image instanceof Uint8Array) || part.image.byteLength === 0) {
        throw new Error('userContent の画像bytesが不正です')
      }
      // Snapshot the bytes so the caller cannot mutate the in-flight model
      // input after validation.  This copy remains ephemeral to the request.
      if (part.estimatedVisualTokens !== undefined && (!Number.isSafeInteger(part.estimatedVisualTokens) || part.estimatedVisualTokens <= 0 || part.estimatedVisualTokens > 1024)) {
        throw new Error('userContent の estimatedVisualTokens は1から1024の整数で指定してください')
      }
      normalized.push({
        type: 'image', mediaType: part.mediaType, image: new Uint8Array(part.image),
        ...(part.estimatedVisualTokens === undefined ? {} : { estimatedVisualTokens: part.estimatedVisualTokens })
      })
      continue
    }
    throw new Error('userContent のpart形式が不正です')
  }

  if (!hasNonEmptyText) throw new Error('userContent には空でないテキストが必要です')
  if (expectedText !== undefined && text !== expectedText) {
    throw new Error('userContent のテキストが userInput と一致しません')
  }
  return normalized
}
