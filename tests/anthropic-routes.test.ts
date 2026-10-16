import { describe, expect, it } from 'vitest'

import { createSimulatorApp, createSimulatorRuntime } from '../src/server'

const headers = {
  'content-type': 'application/json',
  'x-api-key': 'fake',
  'anthropic-version': '2023-06-01',
}

const stableMessage = {
  id: 'msg_1',
  type: 'message',
  diagnostics: null,
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'hello', citations: null }],
  container: null,
  stop_details: null,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 1,
    output_tokens: 1,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  },
} as const

const validRequest = {
  model: 'claude-test',
  max_tokens: 8,
  messages: [{ role: 'user', content: 'hello' }],
} as const

const validCountRequest = {
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hello' }],
} as const

const supported = { supported: true }
const unsupported = { supported: false }
const betaModel = {
  id: 'claude-test',
  type: 'model',
  display_name: 'Claude Test',
  created_at: '2026-01-01T00:00:00Z',
  deprecated_at: null,
  lifecycle: 'active',
  line: 'sonnet',
  max_input_tokens: 200_000,
  max_tokens: 8_192,
  retires_at: null,
  allowed_fallback_models: null,
  capabilities: {
    batch: unsupported,
    citations: unsupported,
    code_execution: unsupported,
    compaction: null,
    context_management: {
      clear_thinking_20251015: null,
      clear_tool_uses_20250919: null,
      compact_20260112: null,
      supported: false,
    },
    effort: {
      high: unsupported,
      low: supported,
      max: unsupported,
      medium: supported,
      supported: true,
      xhigh: null,
    },
    image_input: supported,
    pdf_input: unsupported,
    server_tools: {
      code_execution: unsupported,
      supported: false,
      web_search: unsupported,
    },
    structured_outputs: unsupported,
    thinking: {
      supported: true,
      types: {
        adaptive: supported,
        between_tools: supported,
        disabled: unsupported,
        enabled: supported,
      },
    },
  },
} as const

describe('anthropic routes', () => {
  it('requires auth/version and returns provider-native errors', async () => {
    const runtime = createSimulatorRuntime()
    const { controller } = runtime
    const app = createSimulatorApp(runtime)
    const missing = await app.handle(
      new Request('http://simulator/v1/messages', { method: 'POST', body: '{}' }),
    )
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({ type: 'error' })

    const version = await app.handle(
      new Request('http://simulator/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'fake' },
        body: '{}',
      }),
    )
    expect(version.status).toBe(400)

    const excludedTool = await app.handle(
      new Request('http://simulator/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...validRequest,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        }),
      }),
    )
    expect(excludedTool.status).toBe(400)
    expect(await excludedTool.json()).toMatchObject({
      error: { type: 'invalid_request_error' },
    })
    controller.assertExhausted()
  })

  it('serves non-streaming messages, token counts, models, and beta query form', async () => {
    const runtime = createSimulatorRuntime()
    const { controller } = runtime
    controller.enqueue({
      provider: 'anthropic',
      exchanges: [
        {
          label: 'message',
          request: { method: 'POST', path: '/v1/messages' },
          response: {
            kind: 'json',
            body: {
              ...stableMessage,
              context_management: null,
              diagnostics: null,
              usage: {
                ...stableMessage.usage,
                fallback_credit: null,
                iterations: null,
                speed: null,
              },
            },
          },
        },
        {
          label: 'count',
          request: { method: 'POST', path: '/v1/messages/count_tokens' },
          response: {
            kind: 'json',
            body: { context_management: null, input_tokens: 3 },
          },
        },
        {
          label: 'models',
          request: { method: 'GET', path: '/v1/models' },
          response: { kind: 'json', body: { data: [], has_more: false, first_id: null, last_id: null } },
        },
      ],
    })
    const app = createSimulatorApp(runtime)
    const message = await app.handle(
      new Request('http://simulator/v1/messages?beta=true', {
        method: 'POST',
        headers: { ...headers, 'anthropic-beta': 'test-beta' },
        body: JSON.stringify(validRequest),
      }),
    )
    expect(message.status).toBe(200)
    expect(message.headers.get('request-id')).toBeTruthy()
    const count = await app.handle(
      new Request('http://simulator/v1/messages/count_tokens?beta=true', {
        method: 'POST',
        headers,
        body: JSON.stringify(validCountRequest),
      }),
    )
    expect(await count.json()).toEqual({ context_management: null, input_tokens: 3 })
    const models = await app.handle(new Request('http://simulator/v1/models', { headers }))
    expect(models.status).toBe(200)
    controller.assertExhausted()
  })

  it('enforces the required usage.speed field in message responses', async () => {
    const runtime = createSimulatorRuntime()
    runtime.controller.enqueue({
      provider: 'anthropic',
      exchanges: [{
        label: 'response missing required speed',
        request: { method: 'POST', path: '/v1/messages' },
        response: {
          kind: 'json',
          body: {
            ...stableMessage,
            usage: Object.fromEntries(
              Object.entries(stableMessage.usage).filter(([key]) => key !== 'speed'),
            ),
          },
        },
      }],
    })

    const response = await createSimulatorApp(runtime).handle(
      new Request('http://simulator/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(validRequest),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: expect.stringContaining("usage must have required property 'speed'") },
    })
    runtime.controller.assertExhausted()
  })

  it('accepts beta model metadata with thinking.between_tools and rejects omissions', async () => {
    const runtime = createSimulatorRuntime()
    runtime.controller.enqueue({
      provider: 'anthropic',
      exchanges: [
        {
          label: 'beta model metadata',
          request: { method: 'GET', path: '/v1/models/claude-test' },
          response: { kind: 'json', body: betaModel },
        },
        {
          label: 'beta model missing between_tools capability',
          request: { method: 'GET', path: '/v1/models/claude-test' },
          response: {
            kind: 'json',
            body: {
              ...betaModel,
              capabilities: {
                ...betaModel.capabilities,
                thinking: {
                  ...betaModel.capabilities.thinking,
                  types: {
                    adaptive: supported,
                    disabled: unsupported,
                    enabled: supported,
                  },
                },
              },
            },
          },
        },
      ],
    })
    const app = createSimulatorApp(runtime)
    const request = () => new Request('http://simulator/v1/models/claude-test?beta=true', {
      headers: { ...headers, 'anthropic-beta': 'test-beta' },
    })

    const accepted = await app.handle(request())
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      capabilities: { thinking: { types: { between_tools: { supported: true } } } },
    })

    const rejected = await app.handle(request())
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: expect.stringContaining("must have required property 'between_tools'") },
    })
    runtime.controller.assertExhausted()
  })

  it('emits named SSE frames and rejects excluded variants before streaming', async () => {
    const runtime = createSimulatorRuntime()
    const { controller } = runtime
    controller.enqueue({
      provider: 'anthropic',
      exchanges: [
        {
          label: 'stream',
          request: { method: 'POST', path: '/v1/messages' },
          response: {
            kind: 'stream',
            steps: [
              {
                kind: 'event',
                event: {
                  type: 'message_start',
                  message: { ...stableMessage, content: [], stop_reason: null },
                },
              },
              {
                kind: 'event',
                event: {
                  type: 'message_delta',
                  delta: {
                    container: null,
                    stop_details: null,
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                  },
                  usage: {
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    input_tokens: 1,
                    output_tokens: 1,
                    output_tokens_details: null,
                    server_tool_use: null,
                  },
                },
              },
              { kind: 'event', event: { type: 'message_stop' } },
              { kind: 'close' },
            ],
          },
        },
        {
          label: 'excluded',
          request: { method: 'POST', path: '/v1/messages' },
          response: {
            kind: 'stream',
            steps: [{ kind: 'event', event: { type: 'citation_delta' } }],
          },
        },
      ],
    })
    const app = createSimulatorApp(runtime)
    const response = await app.handle(
      new Request('http://simulator/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...validRequest, stream: true }),
      }),
    )
    const text = await response.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"type":"message_stop"')
    const excluded = await app.handle(
      new Request('http://simulator/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...validRequest, stream: true }),
      }),
    )
    expect(excluded.status).toBe(400)
    expect(await excluded.json()).toMatchObject({ type: 'error' })
    controller.assertExhausted()
  })
})
