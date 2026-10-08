import { describe, expect, it } from 'vitest'

import {
  assessPromotion,
  compareVersions,
  diffSchemas,
  planUpdates,
  scopedDiscriminators,
} from '../automation/protocol-evolution.mjs'

const BASE = {
  openaiRef: 'a'.repeat(40),
  anthropicSdk: '0.131.0',
  openaiSdk: '7.30.0',
}
const passing = {
  'repository-check': 'passed',
  'consumer-claude': 'passed',
  'consumer-codex': 'passed',
  'consumer-kimi': 'passed',
}

describe('protocol evolution eligibility', () => {
  it('refuses a downgrade or ambiguous SHA, and recognizes independent updates', () => {
    expect(compareVersions('7.30.1', '7.30.0')).toBe(1)
    expect(compareVersions('7.29.0', '7.30.0')).toBe(-1)
    expect(compareVersions('7.30.0', '7.30.0')).toBe(0)
    expect(() => compareVersions('7.31.0-rc.1', '7.30.0')).toThrow()
    expect(() => planUpdates(BASE, { ...BASE, openaiRef: 'main' })).toThrow()
    expect(() => planUpdates(BASE, { ...BASE, anthropicSdk: '0.130.0' })).toThrow()
    expect(planUpdates(BASE, {
      openaiRef: 'b'.repeat(40),
      anthropicSdk: '0.132.0',
      openaiSdk: '7.30.0',
    })).toEqual({ openai: true, anthropic: true, openaiSdk: false })
  })

  it('finds new variant types in reachable upstream schema even when the core profile would filter them', () => {
    const schema = type => ({ properties: { type: { const: type } } })
    const document = {
      paths: {
        '/v1/responses': { post: { operationId: 'createResponse', $ref: '#/components/schemas/Event' } },
        '/v1/other': { get: { operationId: 'ignored', $ref: '#/components/schemas/Unrelated' } },
      },
      components: { schemas: {
        Event: { oneOf: [schema('response.completed'), { $ref: '#/components/schemas/Added' }] },
        Added: schema('response.new_upstream_type'),
        Unrelated: schema('out.of.scope'),
      } },
    }
    expect(scopedDiscriminators(document, ['createResponse'])).toEqual([
      'response.completed', 'response.new_upstream_type',
    ])
  })

  it('allows only additions of non-required properties', () => {
    const before = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    const after = {
      ...before,
      properties: { ...before.properties, diagnostic: { type: 'string' } },
    }
    expect(diffSchemas(before, after)).toEqual({
      safe: [{ kind: 'optional-property-added', path: '/properties/diagnostic' }],
      review: [],
    })
    expect(diffSchemas(before, { ...after, required: ['id', 'diagnostic'] }).review.length).toBeGreaterThan(0)
    expect(diffSchemas(before, { ...before, properties: { id: { type: 'number' } } }).review).toHaveLength(1)
    expect(diffSchemas({ enum: ['one'] }, { enum: ['one', 'two'] }).review).toHaveLength(1)
    expect(diffSchemas(before, { ...before, description: 'new docs' }).review).toHaveLength(0)
  })

  it('never mistakes self-generated fixtures for independent certification', () => {
    const input = {
      invariantChanges: [],
      schema: { safe: [], review: [] },
      rawDiscriminators: { added: [], removed: [] },
      anthropicDeclarationsChanged: false,
      gates: passing,
    }
    expect(assessPromotion(input).verdict).toBe('safe')
    expect(assessPromotion({ ...input, gates: { ...passing, 'consumer-codex': 'missing' } }).verdict).toBe('blocked')
    expect(assessPromotion({ ...input, rawDiscriminators: { added: ['response.new'], removed: [] } }).verdict).toBe('review')
    expect(assessPromotion({ ...input, schema: { safe: [], review: [{ path: '/required' }] } }).verdict).toBe('review')
    expect(assessPromotion({ ...input, invariantChanges: ['protocol/core-scope.json'] }).verdict).toBe('blocked')
  })
})
