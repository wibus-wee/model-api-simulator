import type { JsonObject, JsonValue, ObservedRequest, StreamStep } from '../contract'
import { isJsonArray, isJsonObject } from '../contract'
import type { ScenarioController } from '../core/scenario-runtime'
import { createScheduledStream } from '../core/stream-scheduler'
import { encodeChatCompletionEvent, encodeOpenAiEvent } from './sse'

const FALLBACK_MODEL = 'gpt-test'

/**
 * Synthesises a protocol-valid OpenAI Responses / models reply when no enqueued
 * exchange claims the request. Mirrors Anthropic autoRespond for E2E mock-server use.
 */
export function autoOpenAiResponse(
  controller: ScenarioController,
  observed: Omit<ObservedRequest, 'index'>,
): Response {
  const body = observed.body !== undefined && isJsonObject(observed.body) ? observed.body : {}
  const method = observed.method.toUpperCase()

  if (method === 'GET' && observed.path.startsWith('/v1/models')) {
    return modelsResponse(observed.path)
  }

  if (method === 'POST' && observed.path === '/v1/responses/input_tokens') {
    return Response.json(
      {
        object: 'response.input_tokens',
        input_tokens: estimateInputTokens(body),
      },
      { headers: { 'x-request-id': 'req_simulator_auto' } },
    )
  }

  if (method === 'POST' && observed.path === '/v1/chat/completions') {
    const model = typeof body.model === 'string' ? body.model : FALLBACK_MODEL
    const base = { id: `chatcmpl_auto_${controller.requests().length}`, created: 1, model }
    const text = 'Synthetic simulator reply.'
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    if (body.stream === true) {
      const chunk = (choices: JsonValue[], extra: JsonObject = {}): StreamStep => ({
        kind: 'event', event: { ...base, object: 'chat.completion.chunk', choices, ...extra },
      })
      const steps: StreamStep[] = [
        chunk([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]),
        chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      ]
      if (isJsonObject(body.stream_options) && body.stream_options.include_usage === true) {
        steps.push(chunk([], { usage }))
      }
      steps.push({ kind: 'event', event: '[DONE]' }, { kind: 'close' })
      return new Response(createScheduledStream(controller, steps, step => encodeChatCompletionEvent(step.event)), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': 'req_simulator_auto' },
      })
    }
    return Response.json({ ...base, object: 'chat.completion', usage,
      choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, finish_reason: 'stop', logprobs: null }],
    }, { headers: { 'x-request-id': 'req_simulator_auto' } })
  }

  if (method === 'POST' && observed.path === '/v1/responses') {
    const model = typeof body.model === 'string' ? body.model : FALLBACK_MODEL
    const text = replyText(body)
    const response = completedResponse(controller, model, text)
    if (body.stream === true) {
      const steps = streamSteps(response, text)
      return new Response(
        createScheduledStream(controller, steps, step => encodeOpenAiEvent(step.event)),
        {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-request-id': 'req_simulator_auto',
          },
        },
      )
    }
    return Response.json(response, {
      headers: { 'x-request-id': 'req_simulator_auto' },
    })
  }

  // Resource GETs / cancel / delete without a matching exchange: empty list or not found-ish JSON.
  if (method === 'GET' && observed.path.includes('/input_items')) {
    return Response.json(
      { object: 'list', data: [], first_id: '', last_id: '', has_more: false },
      { headers: { 'x-request-id': 'req_simulator_auto' } },
    )
  }

  return Response.json(
    {
      error: {
        message: `No auto-response for ${method} ${observed.path}`,
        type: 'invalid_request_error',
        code: 'simulator_auto_unsupported',
      },
    },
    {
      status: 400,
      headers: { 'x-request-id': 'req_simulator_auto' },
    },
  )
}

function modelsResponse(path: string): Response {
  const model = {
    id: FALLBACK_MODEL,
    object: 'model',
    created: 1,
    owned_by: 'simulator',
  }
  if (path === '/v1/models') {
    return Response.json(
      { object: 'list', data: [model], has_more: false },
      { headers: { 'x-request-id': 'req_simulator_auto' } },
    )
  }
  const id = decodeURIComponent(path.slice('/v1/models/'.length)) || model.id
  return Response.json(
    { ...model, id },
    { headers: { 'x-request-id': 'req_simulator_auto' } },
  )
}

function completedResponse(
  controller: ScenarioController,
  model: string,
  text: string,
): JsonObject {
  const id = `resp_simulator_auto_${controller.requests().length}`
  const messageId = `msg_simulator_auto_${controller.requests().length}`
  const outputText = {
    type: 'output_text',
    text,
    annotations: [],
    logprobs: [],
  }
  return {
    id,
    object: 'response',
    access_programs: null,
    created_at: 1,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model,
    output: [
      {
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [outputText],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    service_tier: 'default',
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: Math.max(1, Math.ceil(text.length / 4)),
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1 + Math.max(1, Math.ceil(text.length / 4)),
    },
    metadata: {},
  }
}

function streamSteps(response: JsonObject, text: string): readonly StreamStep[] {
  const outputItem = isJsonArray(response.output) ? response.output[0] : undefined
  const message = outputItem !== undefined && isJsonObject(outputItem) ? outputItem : undefined
  const messageId = message && typeof message.id === 'string'
    ? message.id
    : 'msg_simulator_auto'
  const events: JsonValue[] = [
    { type: 'response.created', sequence_number: 0, response },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        type: 'message',
        id: messageId,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      sequence_number: 4,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      sequence_number: 5,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [], logprobs: [] },
    },
    {
      type: 'response.output_item.done',
      sequence_number: 6,
      output_index: 0,
      item: {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    },
    { type: 'response.completed', sequence_number: 7, response },
  ]
  return [
    ...events.map(event => ({ kind: 'event' as const, event })),
    { kind: 'close' as const },
  ]
}

function replyText(body: JsonObject): string {
  const prompt = extractInputText(body.input)
  return prompt
    ? `[simulator] received: ${prompt}`
    : '[simulator] auto reply'
}

function extractInputText(input: JsonValue | undefined): string | undefined {
  if (typeof input === 'string') {
    return input
  }
  if (input === undefined || !isJsonArray(input)) {
    return undefined
  }
  const parts: string[] = []
  for (const item of input) {
    if (!isJsonObject(item)) {
      continue
    }
    if (typeof item.content === 'string') {
      parts.push(item.content)
      continue
    }
    if (!isJsonArray(item.content)) {
      continue
    }
    for (const block of item.content) {
      if (isJsonObject(block) && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function estimateInputTokens(body: JsonObject): number {
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4))
}
