import type { JsonValue } from '../contract'

const encoder = new TextEncoder()

export function encodeOpenAiEvent(event: JsonValue): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

/** Chat Completions terminates with a literal, non-JSON SSE data frame. */
export function encodeChatCompletionEvent(event: JsonValue): Uint8Array {
  return event === '[DONE]' ? encoder.encode('data: [DONE]\n\n') : encodeOpenAiEvent(event)
}
