import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const REQUIRED_GATES = ['repository-check', 'consumer-claude', 'consumer-codex', 'consumer-kimi']
const INVARIANT_FILES = [
  'protocol/core-scope.json',
  'protocol/openai/stream-grammar.json',
  'protocol/openai/chat-stream-grammar.json',
  'protocol/openai/transition-corpus.json',
  'protocol/openai/chat-transition-corpus.json',
  'protocol/anthropic/stream-grammar.json',
  'protocol/anthropic/transition-corpus.json',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function put(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function argument(name) {
  const at = process.argv.indexOf(name)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

async function emitOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}\n`).join(''))
}

export function compareVersions(left, right) {
  const parse = version => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    if (!match) throw new Error(`Expected stable semver: ${version}`)
    return match.slice(1).map(Number)
  }
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i])
  }
  return 0
}

export function planUpdates(pinned, upstream) {
  if (!/^[0-9a-f]{40}$/i.test(upstream.openaiRef)) {
    throw new Error('OpenAI upstream ref must be a full commit SHA')
  }
  for (const field of ['anthropicSdk', 'openaiSdk']) {
    if (compareVersions(upstream[field], pinned[field]) < 0) {
      throw new Error(`${field} latest is older than the pinned version; refusing downgrade`)
    }
  }
  return {
    openai: pinned.openaiRef !== upstream.openaiRef,
    anthropic: compareVersions(upstream.anthropicSdk, pinned.anthropicSdk) > 0,
    openaiSdk: compareVersions(upstream.openaiSdk, pinned.openaiSdk) > 0,
  }
}

// Inspect discriminators in the *raw* API, before the core allowlist removes branches.
// Walk only selected operations and their reachable components, not unrelated API families.
export function scopedDiscriminators(document, operationIds) {
  const operations = new Set(operationIds)
  const references = []
  const seen = new Set()
  const values = new Set()
  function walk(value) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    const tag = value.properties?.type
    if (tag && typeof tag === 'object') {
      if (typeof tag.const === 'string') values.add(tag.const)
      if (Array.isArray(tag.enum)) {
        for (const entry of tag.enum) if (typeof entry === 'string') values.add(entry)
      }
    }
    const mapping = value.discriminator?.mapping
    if (mapping && typeof mapping === 'object') {
      for (const key of Object.keys(mapping)) values.add(key)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/')) {
        references.push(child)
      } else {
        walk(child)
      }
    }
  }
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of ['get', 'post', 'delete']) {
      const operation = pathItem?.[method]
      if (operation && operations.has(operation.operationId)) walk(operation)
    }
  }
  for (let index = 0; index < references.length; index++) {
    const ref = references[index]
    if (seen.has(ref)) continue
    seen.add(ref)
    let target = document
    for (const part of ref.slice(2).split('/')) {
      target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')]
    }
    if (target === undefined) throw new Error(`Unresolved upstream reference: ${ref}`)
    walk(target)
  }
  return [...values].sort()
}

function delta(before, after) {
  const a = new Set(before)
  const b = new Set(after)
  return {
    added: [...b].filter(value => !a.has(value)).sort(),
    removed: [...a].filter(value => !b.has(value)).sort(),
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'model-api-simulator-protocol-evolution',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`Upstream lookup failed: ${response.status} ${url}`)
  return await response.text()
}

async function discover() {
  const packageJson = await jsonFile(join(ROOT, 'package.json'))
  const oldOpenai = await jsonFile(join(ROOT, 'protocol/openai/MANIFEST.json'))
  const oldAnthropic = await jsonFile(join(ROOT, 'protocol/anthropic/MANIFEST.json'))
  const scope = await jsonFile(join(ROOT, 'protocol/core-scope.json'))
  const pinned = {
    openaiRef: oldOpenai.upstreamRef,
    anthropicSdk: oldAnthropic.sdkVersion,
    openaiSdk: packageJson.devDependencies.openai,
  }
  const [commitsText, anthropicText, openaiText] = await Promise.all([
    fetchText('https://api.github.com/repos/openai/openai-openapi/commits?path=openapi.json&per_page=1'),
    fetchText('https://registry.npmjs.org/@anthropic-ai%2fsdk/latest'),
    fetchText('https://registry.npmjs.org/openai/latest'),
  ])
  const commits = JSON.parse(commitsText)
  if (!Array.isArray(commits) || commits.length !== 1 || typeof commits[0].sha !== 'string') {
    throw new Error('GitHub latest OpenAPI commit lookup was incomplete')
  }
  const upstream = {
    openaiRef: commits[0].sha,
    anthropicSdk: JSON.parse(anthropicText).version,
    openaiSdk: JSON.parse(openaiText).version,
  }
  const changes = planUpdates(pinned, upstream)
  let rawDiscriminators = { added: [], removed: [] }
  let rawSourceHash = oldOpenai.sourceSha256
  if (changes.openai) {
    const source = ref => `https://raw.githubusercontent.com/openai/openai-openapi/${ref}/openapi.json`
    const [oldRaw, latestRaw] = await Promise.all([
      fetchText(source(pinned.openaiRef)),
      fetchText(source(upstream.openaiRef)),
    ])
    if (sha256(oldRaw) !== oldOpenai.sourceSha256) {
      throw new Error('Pinned OpenAI source no longer matches the reviewed manifest')
    }
    rawSourceHash = sha256(latestRaw)
    rawDiscriminators = delta(
      scopedDiscriminators(JSON.parse(oldRaw), scope.openai.operations),
      scopedDiscriminators(JSON.parse(latestRaw), scope.openai.operations),
    )
  }
  const result = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    pinned, upstream, changes,
    changed: Object.values(changes).some(Boolean),
    rawDiscriminators,
    rawSourceHash,
  }
  await put(argument('--out'), result)
  await emitOutputs({
    changed: result.changed,
    openai_sha: upstream.openaiRef,
    anthropic_version: upstream.anthropicSdk,
    openai_version: upstream.openaiSdk,
    update_openai: changes.openai,
    update_anthropic: changes.anthropic,
    update_openai_sdk: changes.openaiSdk,
  })
  console.log(JSON.stringify({
    changed: result.changed,
    pinned, upstream, changes, rawDiscriminators,
  }, null, 2))
}

// Classify normalised schema changes without allowing new variants or altered
// constraints to be quietly approved. New non-required properties are additive.
export function diffSchemas(before, after) {
  const safe = []
  const review = []
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const pointer = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
  const documentation = new Set(['description', 'summary', 'examples', 'example', 'externalDocs', 'title'])
  function walk(left, right, path, required = new Set()) {
    if (Object.is(left, right)) return
    if (isObject(left) && isObject(right)) {
      const newRequired = new Set(Array.isArray(right.required) ? right.required : [])
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (documentation.has(key) || key.startsWith('x-')) continue
        const at = [...path, key]
        if (!(key in left)) {
          if (path.at(-1) === 'properties' && !required.has(key)) {
            safe.push({ kind: 'optional-property-added', path: pointer(at) })
          } else {
            review.push({ kind: 'added', path: pointer(at) })
          }
        } else if (!(key in right)) {
          review.push({ kind: 'removed', path: pointer(at) })
        } else {
          walk(left[key], right[key], at, key === 'properties' ? newRequired : new Set())
        }
      }
      return
    }
    // Includes changed required / enum / union / anyOf arrays and existing types.
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      review.push({ kind: 'changed', path: pointer(path) })
    }
  }
  walk(before, after, [])
  return { safe, review }
}

function declarationsChanged(before, after) {
  const fingerprint = manifest => (manifest.declarations ?? [])
    .map(item => `${item.path}:${item.sha256}`).sort().join('\n')
  return fingerprint(before) !== fingerprint(after)
}

export function assessPromotion(input) {
  const risks = []
  if (input.invariantChanges.length) {
    risks.push(...input.invariantChanges.map(path => `Invariant changed: ${path}`))
  }
  if (input.schema.review.length) {
    risks.push(`${input.schema.review.length} non-additive schema change(s) require review`)
  }
  if (input.rawDiscriminators.added.length || input.rawDiscriminators.removed.length) {
    risks.push('Upstream discriminator changes found before core filtering')
  }
  if (input.anthropicDeclarationsChanged) {
    risks.push('Anthropic SDK declarations changed outside the certified core snapshot')
  }
  const missingGates = REQUIRED_GATES.filter(key => input.gates[key] !== 'passed')
  if (missingGates.length) risks.push(`Unverified gates: ${missingGates.join(', ')}`)
  return {
    verdict: missingGates.length || input.invariantChanges.length ? 'blocked' : risks.length ? 'review' : 'safe',
    risks,
  }
}

async function evaluate() {
  const baseline = resolve(argument('--baseline'))
  const reportPath = argument('--out')
  const markdownPath = argument('--markdown')
  const discovery = await jsonFile(argument('--discovery'))
  const gates = await jsonFile(argument('--gates'))
  const invariantChanges = []
  for (const path of INVARIANT_FILES) {
    const oldText = await readFile(join(baseline, path))
    const newText = await readFile(join(ROOT, path))
    if (!oldText.equals(newText)) invariantChanges.push(path)
  }
  const baselineOpenai = await jsonFile(join(baseline, 'protocol/openai/openapi.json'))
  const currentOpenai = await jsonFile(join(ROOT, 'protocol/openai/openapi.json'))
  const baselineAnthropic = await jsonFile(join(baseline, 'protocol/anthropic/schema.json'))
  const currentAnthropic = await jsonFile(join(ROOT, 'protocol/anthropic/schema.json'))
  const oDiff = diffSchemas(baselineOpenai, currentOpenai)
  const aDiff = diffSchemas(baselineAnthropic, currentAnthropic)
  const oldAnthropic = await jsonFile(join(baseline, 'protocol/anthropic/MANIFEST.json'))
  const newAnthropic = await jsonFile(join(ROOT, 'protocol/anthropic/MANIFEST.json'))
  const newOpenai = await jsonFile(join(ROOT, 'protocol/openai/MANIFEST.json'))
  const currentPackage = await jsonFile(join(ROOT, 'package.json'))
  if (!discovery.changed) throw new Error('Refusing evaluation of unchanged upstream')
  if (newOpenai.upstreamRef !== discovery.upstream.openaiRef
    || newAnthropic.sdkVersion !== discovery.upstream.anthropicSdk
    || currentPackage.devDependencies.openai !== discovery.upstream.openaiSdk
    || newOpenai.sourceSha256 !== discovery.rawSourceHash) {
    throw new Error('Candidate versions / source hash diverge from independent upstream discovery')
  }
  // The repository check runs TS, SDK conformance, schema coverage and build.
  const schema = {
    safe: [...oDiff.safe, ...aDiff.safe],
    review: [...oDiff.review, ...aDiff.review],
    providers: {
      openai: { safe: oDiff.safe.length, review: oDiff.review.length },
      anthropic: { safe: aDiff.safe.length, review: aDiff.review.length },
    },
  }
  const checked = assessPromotion({
    invariantChanges, schema,
    rawDiscriminators: discovery.rawDiscriminators,
    anthropicDeclarationsChanged: declarationsChanged(oldAnthropic, newAnthropic),
    gates,
  })
  const report = {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    from: discovery.pinned,
    to: discovery.upstream,
    gates, verdict: checked.verdict,
    risks: checked.risks,
    schema,
    invariantChanges,
    rawDiscriminators: discovery.rawDiscriminators,
    evidence: {
      rawSourceHash: discovery.rawSourceHash,
      normalizedOpenaiHash: newOpenai.normalizedSha256,
      normalizedAnthropicHash: newAnthropic.schemaSha256,
      coreProfile: 'protocol/core-scope.json',
    },
  }
  const shortList = (entries, max = 20) => entries.slice(0, max)
    .map(item => `- ${typeof item === 'string' ? item : `${item.kind}: \`${item.path}\``}`)
    .join('\n') || '- None'
  const markdown = [
    '## Continuous protocol evolution',
    '',
    `Policy verdict: **${checked.verdict.toUpperCase()}**`,
    '',
    '| Input | Pinned | Candidate |',
    '| --- | --- | --- |',
    `| OpenAI OpenAPI SHA | \`${discovery.pinned.openaiRef.slice(0, 12)}\` | \`${discovery.upstream.openaiRef.slice(0, 12)}\` |`,
    `| Anthropic SDK | ${discovery.pinned.anthropicSdk} | ${discovery.upstream.anthropicSdk} |`,
    `| OpenAI SDK | ${discovery.pinned.openaiSdk} | ${discovery.upstream.openaiSdk} |`,
    '',
    '### Independent verification gates',
    '',
    ...REQUIRED_GATES.map(key => `- ${key}: **${gates[key] ?? 'missing'}**`),
    '',
    'The repository gate executes official SDK conformance, schema witness/negative-mutation coverage, deterministic stream transitions, historical fixtures, typechecking and build. Consumer gates run actual pinned Claude, Codex and Kimi CLIs against the candidate simulator and Huihua native-store checks.',
    '',
    '### Semantic delta (normalized core)',
    '',
    `- Compatible optional property additions: ${schema.safe.length}`,
    `- Other changes needing inspection: ${schema.review.length}`,
    `- Raw OpenAI discriminators newly seen / removed before filtering: ${discovery.rawDiscriminators.added.length} / ${discovery.rawDiscriminators.removed.length}`,
    '',
    '### Reasons for review or blocking',
    '',
    shortList(checked.risks),
    '',
    '### Schema changes needing review (up to 20)',
    '',
    shortList(schema.review),
    '',
    '### Newly observed upstream discriminators (up to 20)',
    '',
    shortList(discovery.rawDiscriminators.added),
    '',
    '### Provenance and policy',
    '',
    `OpenAI source SHA-256: \`${discovery.rawSourceHash}\`.`,
    '',
    '- Protocol scope and stream grammars are immutable in this automated refresh.',
    '- New union branches, enum values, required fields, stream events and changed declarations are never auto-accepted just because the refreshed schema generated passing witnesses.',
    '- Safe means eligible for optional automatic promotion after every recorded gate passed; review means a PR stays open for human assessment.',
    '- No real upstream model generation is exercised here. Compatibility is verified against official SDKs and independently recorded producer journeys.',
    '',
  ].join('\n')
  await put(reportPath, report)
  await put(markdownPath, markdown)
  await emitOutputs({ safe: checked.verdict === 'safe', verdict: checked.verdict })
  console.log(markdown)
  if (checked.verdict === 'blocked') {
    throw new Error(`Protocol evolution blocked: ${checked.risks.join('; ')}`)
  }
}

async function main() {
  const command = process.argv[2]
  if (command === 'discover') return discover()
  if (command === 'evaluate') return evaluate()
  throw new Error('Usage: node automation/protocol-evolution.mjs discover|evaluate --out ...')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
