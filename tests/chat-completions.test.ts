import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'

import corpus from '../protocol/openai/chat-transition-corpus.json'
import type { JsonObject, StreamStep } from '../src/contract'
import { startModelApiSimulator } from '../src'
import { validateChatCompletionStream } from '../src/openai/chat-state-machine'
import { encodeChatCompletionEvent } from '../src/openai/sse'

const base = { id: 'chatcmpl_test', model: 'gpt-test', created: 1 }
const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
const completion = { ...base, object: 'chat.completion', choices: [
  { index: 0, message: { role: 'assistant', content: 'done', refusal: null }, finish_reason: 'stop', logprobs: null },
], usage }
const chunk = (delta: JsonObject, finish: string | null = null): StreamStep => ({ kind: 'event', event: {
  ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
} })
const done: StreamStep = { kind: 'event', event: '[DONE]' }
const close: StreamStep = { kind: 'close' }

function client(baseURL: string) {
  return new OpenAI({ baseURL, apiKey: 'synthetic-test-key', maxRetries: 0, fetch: (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '127.0.0.1') { throw new Error(`Network escape: ${url}`) }
    return fetch(input, init)
  } })
}

describe('Chat Completions native wire protocol', () => {
  it('runs official SDK streaming function calls, tool return, and a JSON reply', async () => {
    const simulator = await startModelApiSimulator({ strictRequestValidation: true })
    try {
      simulator.controller.enqueue({ provider: 'openai', exchanges: [
        { label: 'tool', request: { method: 'POST', path: '/v1/chat/completions' }, response: { kind: 'stream', steps: [
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, 'tool_calls'),
          { kind: 'event', event: { ...base, object: 'chat.completion.chunk', choices: [], usage } }, done, close,
        ] } },
        { label: 'tool-return', request: { method: 'POST', path: '/v1/chat/completions', bodyTextIncludes: ['call_read', 'tool-output'] }, response: { kind: 'json', body: completion } },
      ] })
      const sdk = client(simulator.openaiBaseUrl)
      const stream = await sdk.chat.completions.create({ model: 'gpt-test', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'read' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] })
      const chunks = []
      for await (const part of stream) { chunks.push(part) }
      expect(chunks).toHaveLength(3)
      const argumentsText = chunks.flatMap(part => part.choices.flatMap(choice => choice.delta.tool_calls?.map(call => call.function?.arguments ?? '') ?? [])).join('')
      expect(JSON.parse(argumentsText)).toEqual({ path: 'README.md' })
      expect(chunks.at(-1)?.usage?.total_tokens).toBe(5)
      const reply = await sdk.chat.completions.create({ model: 'gpt-test', messages: [
        { role: 'user', content: 'read' },
        { role: 'assistant', tool_calls: [{ id: 'call_read', type: 'function', function: { name: 'read', arguments: argumentsText } }] },
        { role: 'tool', tool_call_id: 'call_read', content: 'tool-output' },
      ] })
      expect(reply.choices[0]?.message.content).toBe('done')
      expect(simulator.controller.requests()).toHaveLength(2)
      simulator.controller.assertExhausted()
    }
    finally { await simulator.close() }
  })

  it('encodes literal DONE and validates independently recorded transition corpus', () => {
    expect(new TextDecoder().decode(encodeChatCompletionEvent('[DONE]'))).toBe('data: [DONE]\n\n')
    for (const scenario of corpus.scenarios) {
      expect(validateChatCompletionStream(scenario.steps as StreamStep[]).terminal).toBe(true)
    }
    expect(() => validateChatCompletionStream([chunk({ content: 'a' }), done])).toThrow('finish_reason')
    expect(() => validateChatCompletionStream([chunk({}, 'stop'), chunk({ content: 'late' })])).toThrow('finished choice')
    expect(() => validateChatCompletionStream([done, chunk({})])).toThrow('terminal')
    expect(() => validateChatCompletionStream([chunk({}), close])).toThrow('without [DONE]')
    expect(() => validateChatCompletionStream([
      chunk({ tool_calls: [{ index: 0, id: 'a' }] }), chunk({ tool_calls: [{ index: 0, id: 'b' }] }),
    ])).toThrow('Tool call ID changed')
    const changed = chunk({})
    if (changed.kind !== 'event') { throw new Error('fixture') }
    expect(() => validateChatCompletionStream([chunk({}), { ...changed, event: { ...(changed.event as JsonObject), id: 'other' } }])).toThrow('identity changed')
  })

  it('rejects invalid requests and response chunks, returns HTTP errors, and reports stream errors', async () => {
    const simulator = await startModelApiSimulator({ strictRequestValidation: true })
    try {
      const url = `${simulator.openaiBaseUrl}/chat/completions`
      expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
      expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fake' }, body: '{}' })).status).toBe(400)
      const sdk = client(simulator.openaiBaseUrl)
      simulator.controller.enqueue({ provider: 'openai', exchanges: [
        { label: 'rate-limit', request: { method: 'POST', path: '/v1/chat/completions' }, response: { kind: 'json', status: 429, body: { error: { message: 'synthetic rate limit', type: 'rate_limit_error', param: null, code: null } } } },
        { label: 'stream-error', request: { method: 'POST', path: '/v1/chat/completions' }, response: { kind: 'stream', steps: [
          { kind: 'event', event: { error: { message: 'synthetic stream failure', type: 'server_error', param: null, code: null } } }, close,
        ] } },
        { label: 'bad-chunk', request: { method: 'POST', path: '/v1/chat/completions' }, response: { kind: 'stream', steps: [{ kind: 'event', event: { object: 'chat.completion.chunk' } }, done, close] } },
      ] })
      const request = { model: 'gpt-test', messages: [{ role: 'user' as const, content: 'hi' }] }
      await expect(sdk.chat.completions.create(request)).rejects.toMatchObject({ status: 429 })
      const stream = await sdk.chat.completions.create({ ...request, stream: true })
      await expect((async () => { for await (const _ of stream) { /* consume */ } })()).rejects.toThrow('synthetic stream failure')
      await expect(sdk.chat.completions.create({ ...request, stream: true })).rejects.toMatchObject({ status: 400 })
    }
    finally { await simulator.close() }
  })

  it('propagates cancellation and disconnect through the official SDK', async () => {
    const simulator = await startModelApiSimulator()
    try {
      simulator.controller.enqueue({ provider: 'openai', exchanges: [
        { label: 'cancel', request: { method: 'POST', path: '/v1/chat/completions' }, response: { kind: 'stream', steps: [
          chunk({ content: 'partial' }), { kind: 'gate', name: 'cancel-chat' }, chunk({}, 'stop'), done, close,
        ] } },
        { label: 'disconnect', request: { method: 'POST', path: '/v1/chat/completions' }, response: { kind: 'stream', steps: [
          chunk({ content: 'partial' }), { kind: 'gate', name: 'disconnect-chat' }, { kind: 'disconnect', reason: 'test' },
        ] } },
      ] })
      const sdk = client(simulator.openaiBaseUrl)
      const request = { model: 'gpt-test', messages: [{ role: 'user' as const, content: 'hi' }], stream: true as const }
      const stream = await sdk.chat.completions.create(request)
      const iterator = stream[Symbol.asyncIterator]()
      expect((await iterator.next()).value?.choices[0]?.delta.content).toBe('partial')
      await simulator.controller.waitForGate('cancel-chat')
      stream.controller.abort()
      await iterator.return?.()
      const disconnected = await sdk.chat.completions.create(request)
      const received = disconnected[Symbol.asyncIterator]()
      expect((await received.next()).done).toBe(false)
      await simulator.controller.waitForGate('disconnect-chat')
      simulator.controller.release('disconnect-chat')
      await expect(received.next()).rejects.toThrow()
    }
    finally { await simulator.close() }
  })

  it('auto-responds to Chat Completions without emitting Responses events', async () => {
    const simulator = await startModelApiSimulator({ autoRespond: true, strictRequestValidation: true })
    try {
      const sdk = client(simulator.openaiBaseUrl)
      const request = { model: 'gpt-test', messages: [{ role: 'user' as const, content: 'hi' }] }
      expect((await sdk.chat.completions.create(request)).object).toBe('chat.completion')
      const chunks = []
      for await (const part of await sdk.chat.completions.create({ ...request, stream: true, stream_options: { include_usage: true } })) { chunks.push(part) }
      expect(chunks.map(part => part.object)).toEqual(['chat.completion.chunk', 'chat.completion.chunk', 'chat.completion.chunk'])
      expect(chunks.at(-1)?.usage?.total_tokens).toBe(2)
    }
    finally { await simulator.close() }
  })
})
