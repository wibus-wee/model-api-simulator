import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ISSUE_MARKER = '<!-- model-api-simulator:protocol-evolution-anomaly:v1 -->'
export const ISSUE_TITLE = 'Protocol evolution: attention required'

function argument(name) {
  const at = process.argv.indexOf(name)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`)
  return value
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function observedStages(env = process.env) {
  return {
    discovery: env.PROTOCOL_DISCOVERY_OUTCOME || 'missing',
    refresh: env.PROTOCOL_REFRESH_OUTCOME || 'missing',
    typecheck: env.PROTOCOL_TYPECHECK_OUTCOME || 'missing',
    tests: env.PROTOCOL_TESTS_OUTCOME || 'missing',
    'protocol-check': env.PROTOCOL_PROTOCOL_CHECK_OUTCOME || 'missing',
    'coverage-check': env.PROTOCOL_COVERAGE_OUTCOME || 'missing',
    build: env.PROTOCOL_BUILD_OUTCOME || 'missing',
    evaluation: env.PROTOCOL_EVALUATION_OUTCOME || 'missing',
    candidate: env.PROTOCOL_CANDIDATE_OUTCOME || 'missing',
    promotion: env.PROTOCOL_PROMOTION_OUTCOME || 'missing',
  }
}

// All abnormal outcomes are actionable, even if the validation script has
// already written a "review" verdict and its shell step technically passed.
export function classifyAnomaly({ discovery, evaluation, stages, jobStatus }) {
  const failed = Object.entries(stages)
    .filter(([, status]) => status === 'failure' || status === 'cancelled')
    .map(([key]) => key)

  if (failed.length || jobStatus === 'failure' || jobStatus === 'cancelled') {
    return { kind: 'pipeline-failure', failed, message: 'The protocol evaluation or publication pipeline failed.' }
  }
  if (!discovery) {
    return { kind: 'missing-evidence', failed: [], message: 'No upstream discovery evidence was produced.' }
  }
  if (discovery.changed === false) return null
  if (!evaluation) {
    return { kind: 'missing-evidence', failed: [], message: 'Changed upstream without a complete evaluation report.' }
  }
  if (evaluation.verdict === 'review') {
    return { kind: 'protocol-drift', failed: [], message: 'Changed upstream requires protocol review, even though the local checks passed.' }
  }
  if (evaluation.verdict === 'blocked') {
    return { kind: 'evaluation-blocked', failed: [], message: 'At least one compatibility gate or invariant blocked the candidate.' }
  }
  if (evaluation.verdict === 'safe') return null
  return { kind: 'missing-evidence', failed: [], message: `Unknown promotion verdict: ${evaluation.verdict}` }
}

const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
const list = values => values.length ? values.map(value => `- ${value}`).join('\n') : '- None'

export function renderAnomalyIssue({ anomaly, discovery, evaluation, stages, runUrl, candidateNumber, repo }) {
  const versions = discovery
    ? [
        '| Source | Pinned | Observed upstream |',
        '| --- | --- | --- |',
        `| OpenAI OpenAPI commit | \`${escape(discovery.pinned?.openaiRef ?? '?')}\` | \`${escape(discovery.upstream?.openaiRef ?? '?')}\` |`,
        `| Anthropic SDK | ${escape(discovery.pinned?.anthropicSdk ?? '?')} | ${escape(discovery.upstream?.anthropicSdk ?? '?')} |`,
        `| OpenAI SDK | ${escape(discovery.pinned?.openaiSdk ?? '?')} | ${escape(discovery.upstream?.openaiSdk ?? '?')} |`,
      ]
    : ['Discovery did not complete; consult workflow logs.']
  const candidates = [
    ...(evaluation?.risks ?? []),
    ...(anomaly.failed.map(stage => `Failed workflow step: ${stage}`)),
  ]
  const metrics = evaluation?.gates ?? {}
  return [
    ISSUE_MARKER,
    '## Simulator protocol evolution needs attention',
    '',
    `**Category:** ${anomaly.kind}`,
    '',
    anomaly.message,
    '',
    `**Evidence:** [GitHub Actions run and archived artifacts](${runUrl})`,
    ...(candidateNumber ? [`**Candidate:** [protocol update PR #${candidateNumber}](https://github.com/${repo}/pull/${candidateNumber})`] : []),
    ...(evaluation ? [`**Compatibility verdict:** ${evaluation.verdict}`] : []),
    '',
    '### Detected upstream versions',
    '',
    ...versions,
    '',
    '### Local metric gates',
    '',
    '| Simulator check | Workflow outcome | Eval verdict |',
    '| --- | --- | --- |',
    ...['typecheck', 'simulator-tests', 'protocol-check', 'coverage-check', 'build'].map(key => {
      const stage = key === 'simulator-tests' ? 'tests' : key
      return `| ${key} | ${escape(stages[stage] ?? 'missing')} | ${escape(metrics[key] ?? 'not evaluated')} |`
    }),
    '',
    '### What requires attention',
    '',
    list(candidates),
    '',
    ...(evaluation?.rawDiscriminators ? [
      '### Raw upstream type changes (before scope filtering)',
      '',
      `- Added: ${evaluation.rawDiscriminators.added.length}`,
      `- Removed: ${evaluation.rawDiscriminators.removed.length}`,
      ...evaluation.rawDiscriminators.added.slice(0, 10).map(type => `- New type: \`${type}\``),
      '',
    ] : []),
    ...(evaluation?.schema ? [
      '### Normalized core schema changes',
      '',
      `- Optional properties: ${evaluation.schema.safe.length}`,
      `- Other changes needing review: ${evaluation.schema.review.length}`,
      ...evaluation.schema.review.slice(0, 10).map(change => `- ${change.kind}: \`${change.path}\``),
      '',
    ] : []),
    '### Next action',
    '',
    anomaly.kind === 'protocol-drift'
      ? 'Review the upstream contract delta, decide whether to extend the supported core profile, and update protocol tests or stream grammars intentionally. Do not accept a new event merely because generated witnesses pass.'
      : 'Inspect the failed stage and its archived artifacts, fix the simulator or infrastructure, and rerun the protocol evolution workflow. Missing tests/evidence must not be treated as a passing compatibility metric.',
    '',
    '_Managed by the simulator workflow. Repeated anomalies update this Issue; a healthy run resolves it._',
    '',
  ].join('\n')
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function existingIssue() {
  const issues = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,body']))
  return issues.find(issue => typeof issue.body === 'string' && issue.body.includes(ISSUE_MARKER))
}

async function publish() {
  const discovery = await optionalJson(argument('--discovery'))
  const evaluation = await optionalJson(argument('--evaluation'))
  const stages = observedStages()
  const anomaly = classifyAnomaly({
    discovery, evaluation, stages,
    jobStatus: process.env.PROTOCOL_JOB_STATUS ?? 'unknown',
  })
  const existing = existingIssue()
  const runUrl = process.env.PROTOCOL_RUN_URL
  const repo = process.env.GH_REPO
  if (!runUrl || !repo) throw new Error('PROTOCOL_RUN_URL and GH_REPO are required')
  if (!anomaly) {
    if (existing) {
      gh(['issue', 'comment', String(existing.number), '--body', `Automatically resolved after a clean simulator protocol evaluation: ${runUrl}`])
      gh(['issue', 'close', String(existing.number), '--reason', 'completed'])
      console.log(`Resolved protocol evolution Issue #${existing.number}`)
    } else {
      console.log('No simulator protocol anomaly to report')
    }
    return
  }

  const body = renderAnomalyIssue({
    anomaly, discovery, evaluation, stages, runUrl,
    candidateNumber: process.env.PROTOCOL_CANDIDATE_NUMBER,
    repo,
  })
  const path = resolve(process.env.RUNNER_TEMP ?? '.', 'protocol-evolution-anomaly.md')
  await writeFile(path, body)
  if (existing) {
    gh(['issue', 'edit', String(existing.number), '--title', ISSUE_TITLE, '--body-file', path])
    console.log(`Updated protocol evolution Issue #${existing.number}`)
  } else {
    console.log(gh(['issue', 'create', '--title', ISSUE_TITLE, '--body-file', path]))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await publish()
}
