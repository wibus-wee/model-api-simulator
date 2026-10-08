import { describe, expect, it } from 'vitest'
import {
  ISSUE_MARKER,
  classifyAnomaly,
  observedStages,
  renderAnomalyIssue,
} from '../automation/protocol-issues.mjs'

const passing = {
  discovery: 'success',
  refresh: 'success',
  typecheck: 'success',
  tests: 'success',
  'protocol-check': 'success',
  'coverage-check': 'success',
  build: 'success',
  evaluation: 'success',
  candidate: 'success',
  promotion: 'skipped',
}
const discovery = {
  changed: true,
  pinned: { openaiRef: 'a'.repeat(40), anthropicSdk: '0.131.0', openaiSdk: '7.30.0' },
  upstream: { openaiRef: 'b'.repeat(40), anthropicSdk: '0.132.1', openaiSdk: '7.30.1' },
}
const evaluation = {
  verdict: 'safe',
  risks: [],
  gates: {
    typecheck: 'passed',
    'simulator-tests': 'passed',
    'protocol-check': 'passed',
    'coverage-check': 'passed',
    build: 'passed',
  },
  rawDiscriminators: { added: [], removed: [] },
  schema: { safe: [], review: [] },
}

describe('simulator-only protocol anomaly issues', () => {
  it('needs no issue when upstream is unchanged or the candidate is safely verified', () => {
    expect(classifyAnomaly({
      discovery: { ...discovery, changed: false }, evaluation: null,
      stages: { ...passing, refresh: 'skipped' }, jobStatus: 'success',
    })).toBeNull()
    expect(classifyAnomaly({ discovery, evaluation, stages: passing, jobStatus: 'success' })).toBeNull()
  })

  it('creates a review issue even when the CI workflow succeeds', () => {
    const reviewed = { ...evaluation, verdict: 'review', risks: ['New stream event requires review'] }
    const anomaly = classifyAnomaly({
      discovery, evaluation: reviewed, stages: passing, jobStatus: 'success',
    })
    expect(anomaly.kind).toBe('protocol-drift')
    const body = renderAnomalyIssue({
      anomaly, discovery, evaluation: reviewed, stages: passing,
      runUrl: 'https://github.com/wibus-wee/model-api-simulator/actions/runs/123',
      candidateNumber: '5',
      repo: 'wibus-wee/model-api-simulator',
    })
    expect(body).toContain(ISSUE_MARKER)
    expect(body).toContain('New stream event requires review')
    expect(body).toContain('/pull/5')
    expect(body).toContain('Simulator check')
    expect(body).not.toContain('huihua')
  })

  it('creates failure or missing-evidence issues rather than trusting green fixtures', () => {
    expect(classifyAnomaly({
      discovery, evaluation, stages: { ...passing, tests: 'failure' },
      jobStatus: 'failure',
    })).toMatchObject({ kind: 'pipeline-failure', failed: ['tests'] })
    expect(classifyAnomaly({
      discovery, evaluation: null, stages: { ...passing, evaluation: 'skipped' },
      jobStatus: 'success',
    }).kind).toBe('missing-evidence')
    expect(classifyAnomaly({
      discovery: null, evaluation: null,
      stages: { ...passing, discovery: 'failure' }, jobStatus: 'failure',
    }).kind).toBe('pipeline-failure')
    expect(classifyAnomaly({
      discovery, evaluation: { ...evaluation, verdict: 'blocked' },
      stages: { ...passing, evaluation: 'failure' }, jobStatus: 'failure',
    }).kind).toBe('pipeline-failure')
  })

  it('maps observable GitHub outcomes without inventing a pass', () => {
    const result = observedStages({ PROTOCOL_TESTS_OUTCOME: 'success' })
    expect(result.tests).toBe('success')
    expect(result.typecheck).toBe('missing')
    expect(result.candidate).toBe('missing')
  })
})
