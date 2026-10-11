import Anthropic from 'anthropic-sdk'
import { describe, expect, it } from 'vitest'

import type { JsonValue } from '../src/contract'
import { JsonSchemaRegistry } from '../src/core/json-schema-registry'
import { createSimulatorApp, createSimulatorRuntime } from '../src/server'

function setup(strictRequestValidation = true) {
  const runtime = createSimulatorRuntime()
  const app = createSimulatorApp(runtime, { autoRespond: 'probes-only', strictRequestValidation })
  const client = new Anthropic({
    apiKey: 'fake', baseURL: 'http://simulator', maxRetries: 0,
    fetch: async (input, init) => app.handle(new Request(input, init)),
  })
  return { runtime, app, client }
}

const headers = { 'x-api-key': 'fake', 'anthropic-version': '2023-06-01' }
const schemas = new JsonSchemaRegistry()

describe('Anthropic model lifecycle probes', () => {
  for (const strict of [false, true]) {
    for (const beta of [false, true]) {
      it(`serves valid model metadata and real SDK filters (strict=${strict}, beta=${beta})`, async () => {
        const { client, runtime } = setup(strict)
        const models = beta ? client.beta.models : client.models
        const page = await models.list({ lifecycle: ['active', 'deprecated'] })
        expect(page.data).toHaveLength(1)
        const model = page.data[0]!
        expect(model.lifecycle).toBe('active')
        const schema = `anthropic:draft-07:${beta ? 'AnthropicBeta' : 'Anthropic'}ModelInfo` as const
        expect(() => schemas.validate(schema, model as unknown as JsonValue)).not.toThrow()
        expect(runtime.controller.requests()[0]?.query).toMatchObject({ 'lifecycle[]': ['active', 'deprecated'] })
        if (beta) { expect(runtime.controller.requests()[0]?.query?.beta).toBe('true') }
        const retrieved = await models.retrieve(model.id)
        expect(() => schemas.validate(schema, retrieved as unknown as JsonValue)).not.toThrow()
        expect(retrieved.id).toBe(model.id)
        const retired = await models.list({ lifecycle: ['retired'] })
        expect(retired.data).toEqual([])
        expect(retired.has_more).toBe(false)
        expect(retired.first_id).toBeNull()
        expect(retired.last_id).toBeNull()
      })
    }
  }

  it('returns the active catalogue with an omitted or empty lifecycle filter', async () => {
    const { client } = setup()
    expect((await client.models.list()).data).toHaveLength(1)
    expect((await client.models.list({ lifecycle: [] })).data).toHaveLength(1)
  })

  it('uses the beta model schema when selected by header alone', async () => {
    const { app } = setup()
    const response = await app.handle(new Request('http://simulator/v1/models/custom-model', {
      headers: { ...headers, 'anthropic-beta': 'test-beta' },
    }))
    expect(response.status).toBe(200)
    const model = await response.json()
    expect(model.id).toBe('custom-model')
    expect(model.allowed_fallback_models).toBeNull()
    expect(() => schemas.validate('anthropic:draft-07:AnthropicBetaModelInfo', model)).not.toThrow()
  })

  it('keeps an unmatched queued conversation intact across probes', async () => {
    const { client, runtime } = setup()
    runtime.controller.enqueue({ provider: 'anthropic', exchanges: [{
      label: 'conversation', request: { method: 'POST', path: '/v1/messages' },
      response: { kind: 'json', status: 503, body: { type: 'error', error: { type: 'api_error', message: 'scripted' } } },
    }] })
    await client.models.list({ lifecycle: ['active'] })
    await client.beta.models.list({ lifecycle: ['retired'] })
    expect(runtime.controller.pendingExchangeCount).toBe(1)
    expect(runtime.controller.requests()).toHaveLength(2)
  })

  it.each([
    'lifecycle%5B%5D=bogus',
    'lifecycle%5B%5D=active&lifecycle%5B%5D=active&lifecycle%5B%5D=active&lifecycle%5B%5D=active',
    'surprise=true',
  ])('rejects invalid strict query without recording or consuming it: %s', async (query) => {
    const { app, runtime } = setup()
    const response = await app.handle(new Request(`http://simulator/v1/models?${query}`, { headers }))
    expect(response.status).toBe(400)
    expect(runtime.controller.requests()).toHaveLength(0)
  })
})
