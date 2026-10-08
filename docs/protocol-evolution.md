# Continuous protocol evolution

The daily [`protocol-evolution.yml`](../.github/workflows/protocol-evolution.yml)
discovers upstream changes, refreshes **exact pinned** OpenAI OpenAPI / Anthropic
SDK / OpenAI SDK versions, regenerates protocol artifacts, runs independent
compatibility gates, and maintains one candidate pull request.

The normal PR/push CI remains offline and deterministic: it never silently
rewrites snapshots.

## Evidence and safety policy

1. Discover latest OpenAPI commit touching `openapi.json` and stable npm SDK
   releases; never downgrade. Pin the *full* upstream commit SHA.
2. Compare OpenAI discriminator identities in selected operations and reachable
   schemas **before** filtering with `protocol/core-scope.json`. This surfaces
   new upstream event/branch types that the core profile might otherwise hide.
3. Refresh via the existing explicit `protocol:refresh:*` scripts and generate
   the checked-in artifact manifest. Never automatically change `core-scope.json`,
   stream grammars or transition corpora.
4. Run `pnpm check` (typecheck, official SDK tests, semantic streaming checks,
   schema witnesses and rejected mutations, Cradle fixtures, build).
5. Run Huihua's **real pinned Claude Code, Codex and Kimi Code CLI** producer
   journeys against this *candidate* simulator, not the historical simulator
   commit. The oracle inspects native session evidence independently.
6. Compare reviewed normalized core snapshots. Only additive **optional**
   properties and documentation metadata qualify for low-risk promotion.
   Required/enum/union/constraint changes, new raw discriminators, Anthropic
   declaration changes and coverage invariant edits require review.
7. Publish an evidence artifact and create/update one candidate PR. Repeated
   failures update one tracking issue rather than silently accepting drift.

`safe` is not a claim about model intelligence or arbitrary API behaviors; it
means all *covered* deterministic wire, state and CLI compatibility gates passed.
`review` still creates a PR, but needs human approval. `blocked` creates no
automated protocol-update PR. Unknown/missing evidence is never a pass.

## Running it

```bash
node automation/protocol-evolution.mjs discover --out /tmp/discovery.json
```

The discovery JSON supplies the exact versions for `pnpm add` and
`protocol:refresh:*`. The workflow saves an immutable copy of the baseline,
runs the original generation/check commands, and then evaluates the result:

```bash
node automation/protocol-evolution.mjs evaluate \
  --baseline /tmp/protocol-baseline \
  --discovery /tmp/discovery.json \
  --gates /tmp/protocol-gates.json \
  --out /tmp/evaluation.json \
  --markdown /tmp/evaluation.md
```

`evaluate` will reject candidate versions that diverge from the discovered
commit and SDK versions; it cannot be used as proof of completed tests without
all explicit verification gates.

## Repository configuration

The workflow needs Actions permission to create pull requests, plus
`contents: write`, `pull-requests: write`, and `issues: write`. It uses
`GITHUB_TOKEN` by default, so the **full eval runs in the scheduled workflow**:
a PR created with that token does not automatically trigger normal PR CI.

For independently triggered PR checks, configure a fine-grained bot token or
GitHub App installation token as `PROTOCOL_UPDATE_TOKEN`, scoped to this
repository with Contents and Pull Requests write access.

Automatic merge is deliberately opt-in:
set the repository variable `PROTOCOL_AUTO_PROMOTE=true` **and** configure
`PROTOCOL_UPDATE_TOKEN`. Only `safe` candidates are eligible; the job must
observe passing PR checks with `gh pr checks --watch --fail-fast` before
merging. Leaving either unset simply preserves a reviewed update PR.
The current repository must allow Actions-created pull requests.

## Boundaries

- Latest upstream OpenAPI is an *official schema source*, not a guarantee of
  every live server deployment. This automation does not call real model APIs.
- Raw discriminator monitoring is scoped to OpenAI operations selected by the
  current core; unrelated APIs and unreferenced declarations are not certified.
- An Anthropic SDK declaration change requires review even when the filtered
  schema did not change, preventing silent out-of-scope union growth.
- The consumer lane pins real CLI versions while using Huihua's checkout at a
  logged commit; a moving Huihua main can cause a separate environment failure.
- Hosted provider tools, multimedia, non-core APIs and arbitrary agent traffic
  remain outside the existing simulator scope. Do not infer global compatibility
  from a passing core evaluation.
