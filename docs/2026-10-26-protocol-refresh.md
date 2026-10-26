# October 26 protocol refresh

## Root cause and compatibility boundary

The SDK 1.3.0 changelog says hardcoded endpoint query parameters are no longer
sent. Capturing real `client.beta.models.list()` and `retrieve()` requests confirms
that neither `beta=true` nor `anthropic-beta` is sent by default. `__qualifiers`
is internal SDK metadata, not an HTTP signal. Stable and beta callers are therefore
indistinguishable on these routes; guessing from User-Agent would also be wrong.

Previously the auto responder selected the stable model shape for these requests,
omitting `allowed_fallback_models`. The two beta lifecycle tests failed in both
strict and permissive request-validation modes. This field already existed in the
pinned schema; it is not a newly required field in SDK 1.3.0.

Model auto responses now include the complete known beta model shape, consumable
by both SDK namespaces. For unmarked model responses, validation accepts the exact
stable shape or the exact beta shape (selected by the presence of its extension
field). Explicit beta requests still require the beta shape. Missing fields,
invalid values and unknown properties still fail. No generated schema is loosened,
and message/SSE validation is unchanged. Legacy `beta=true` and header-only calls
remain supported. SDK namespaces must not be mistaken for distinct wire routes.

## Reviewed snapshot changes

- Anthropic SDK: 1.1.0 to 1.3.0, exact lockfile integrity retained.
- OpenAI source: 290bd01b67ff8fc8f87545794197c1413fb740d1 to
  8243cc8fa6f04430fb1f1a6a2cb926fbeb4f7f26. Normalized core is unchanged;
  source provenance and manifest are refreshed. OpenAI SDK remains 7.43.0.
- Four Anthropic beta parameter catalogues add three beta names. The declarations
  already accept arbitrary beta strings; the new names do not expand execution.
- Two optional `thread` properties reference `BetaMessageThreadParam`. Its
  discriminated `create`/`continue` branches remain excluded by the existing core
  allowlist, yielding a false definition. Null is accepted; server-held thread
  operations remain rejected. Regression assertions preserve this boundary.
- Skill description changes are documentation-only. Core scope, stream grammars,
  transition corpora and promotion safety policy are unchanged.

This is an explicitly reviewed update, not a change to automatically accept future
non-additive protocol changes. The earlier BLOCKED run correctly stopped publication.

## Verification

Reproduced the original two failures against SDK 1.3.0 before the fix. The final
suite adds legacy/unmarked list and retrieve routes, exact shape negative cases,
and the excluded thread boundary. Run `pnpm check` for all five independent gates:
typecheck, complete tests, snapshot integrity, schema/transition coverage and build.

Local Node 24.22.1 result: all five gates passed, 17 test files / 83 tests;
14,500 schema branches, 62 transitions, 16,886 valid witnesses and 2,468 rejected
mutations. This is simulator/SDK conformance evidence, not live-provider behavior.
