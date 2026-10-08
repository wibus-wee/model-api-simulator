# Continuous protocol compatibility

The daily [`protocol-evolution.yml`](../.github/workflows/protocol-evolution.yml)
is an **internal maintenance workflow for model-api-simulator only**. It detects
upstream OpenAI/Anthropic protocol and SDK changes, proposes refreshed simulator
contract snapshots, runs simulator-owned compatibility metrics, and reports
unsafe changes or failures as a managed GitHub Issue.

It does **not** run application-specific tests, clone consumer repositories, or
change other projects.

## What happens on each run?

1. **Discover** the most recent upstream OpenAI `openapi.json` revision and the
   stable `@anthropic-ai/sdk` and `openai` npm releases. Fetch the pinned and
   latest raw OpenAI documents, verify the pinned hash, and inspect discriminator
   changes before the core allowlist filters new upstream variants.
2. **Reconcile** a temporary candidate, updating exact pinned versions with the
   existing `protocol:refresh:openai`, `protocol:refresh:anthropic`, and
   `protocol:generate` scripts. Only tracked simulator snapshots, manifests
   and package locks can be updated automatically.
3. **Eval** with five explicit, independent, simulator-only gates:

   | Gate | Command | Checks |
   | --- | --- | --- |
   | Typecheck | `pnpm typecheck` | TypeScript surface and test types |
   | Simulator tests | `pnpm test` | Official SDK compatibility, JSON/SSE, tool turns, stream scheduling, state machines, negative and error paths, fixture conformance |
   | Protocol integrity | `pnpm protocol:check` | Snapshot and artifact fingerprints |
   | Protocol coverage | `pnpm coverage:check` | Generated schema witnesses, rejected mutations, covered branches and stream transitions |
   | Build | `pnpm build` | Distributable package artifacts |

   Every gate's observed result is recorded, including failures and skipped
   steps. A missing result is not an automatic pass.

4. **Assess semantic risk.** The checked-in `protocol/core-scope.json`,
   grammars and transition corpora are immutable during automated refreshes.
   A low-risk candidate may contain additive optional schema properties, without
   breaking SDK tests, altering required/enum/union constraints or introducing
   new upstream discriminators. Changes in Anthropic type declarations trigger
   review even if the narrowed core profile still passes.
5. **Propose an update PR** only after the evidence and policy checks complete.
   Repeated runs maintain the same candidate branch instead of opening a new
   PR every day.

### When does it create an Issue?

The workflow owns one deduplicated Issue titled
**"Protocol evolution: attention required"**, with a hidden stable marker so
it does not accidentally modify unrelated Issues.

- **CI/pipeline failure:** snapshot refresh, SDK tests, coverage, generation,
  PR publishing or other required steps failed. The Issue identifies which
  stage failed and links to the run and uploaded evidence.
- **Review-needed protocol drift:** all simulator tests may pass, but a new
  upstream event/type, changed required fields/constraints, or another contract
  change cannot be certified safe automatically. An Issue is created/updated
  even though GitHub Actions may show a successful workflow.
- **Missing evaluation evidence:** upstream changed but no conclusive candidate
  verdict exists. This remains actionable, never counted as a pass.

An anomaly updates the existing open managed Issue rather than creating daily
duplicates. The next clean/approved run automatically comments on and closes
the issue. Each run retains its JSON report and logs as an Actions artifact
for 30 days. A **candidate update PR** and an **anomaly Issue** have different
purposes: the PR proposes changes; the Issue explains why attention is needed.

### Automatic merge is opt-in

Normal behavior is **propose a PR, never merge it automatically**.

Set the repository variable `PROTOCOL_AUTO_PROMOTE=true` and provide a
`PROTOCOL_UPDATE_TOKEN` (a fine-grained bot token or GitHub App token capable
of triggering the independent pull-request CI) to permit the optional
post-evaluation promotion step. It also requires a `safe` semantic verdict
and passing PR checks. A drift-review PR is never promoted automatically.

GitHub Actions must be permitted to create pull requests in repository
settings. The default `GITHUB_TOKEN` can still publish an Issue and, when
permitted by repository settings, a candidate PR; PRs created with that token
do not automatically trigger a second CI run. The scheduled workflow runs
its own five independent gates before producing the candidate.

## Local inspection

```bash
# Networked discovery; writes pinned/latest version evidence.
node automation/protocol-evolution.mjs discover --out /tmp/discovery.json
```

The GitHub workflow uses the exact identities in the discovery JSON, takes a
copy of the current protocol baseline, and runs the refresh + five metrics.
The final policy check can also be reproduced locally once those inputs exist:

```bash
node automation/protocol-evolution.mjs evaluate \
  --baseline /tmp/protocol-baseline \
  --discovery /tmp/discovery.json \
  --gates /tmp/protocol-gates.json \
  --out /tmp/evaluation.json \
  --markdown /tmp/evaluation.md
```

`evaluate` rejects candidates whose versions or source hash do not match
independent discovery evidence. It cannot authenticate manually fabricated
gate JSON: the production workflow supplies recorded GitHub step outcomes
after actually running every metric.

## Scope and limits

- Only the simulator's supported *core protocol profile* is certified, not
  every feature the upstream providers expose. Unselected API families and
  unreferenced declarations remain outside this system.
- Upstream schemas and SDK typings are independent sources of API-shape
  evidence, but passing a core compatibility Eval does not prove equivalence
  with every live provider deployment. The workflow does not call paid model
  APIs or measure model intelligence.
- A clean local test suite is not sufficient to approve a semantic contract
  change: union variants, new event types and non-additive changes require
  an explicit human decision before expanding simulator support.
