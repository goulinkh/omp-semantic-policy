# Implementation Roadmap

## Current implementation

The marketplace plugin now includes:

- provider-independent actions, decisions, instruction sources, snapshots, audits, and policy-model contracts;
- canonical nearest-worktree identity, Git-root-bounded discovery, nested-repository exclusion, symlink canonicalization, and subtree applicability;
- deterministic compilation with heading/phase context, provenance, precedence, content-addressed snapshot identity, and explicit compiler/model/question/threshold versions;
- profile-scoped SQLite migrations, projects, immutable snapshots, consent, stale transitions, and redacted audits with separate raw-provider, adapter, and final-enforcement diagnostics;
- TypeSafe SDK integration, models-list validation, lossless whole-rule chunk coverage for oversized policies, conservative aggregation, thresholded decisions, `jev-latest` selection with per-chunk resolved-model diagnostics, and explicit unassessed provider fallback;
- automatic onboarding plus `/policy status`, `/policy coverage`, `/policy onboard`, `/policy review`, `/policy audit [1–100]`, and `/policy consent`;
- pre-effect gates for registered tools, direct shell, direct Python, and session-stop workflow checks, with grounded local path protections before remote-coverage filtering;
- outcome recording through `tool_result`, request-scoped current-turn context, digest-bound exact-action authorization, and policy-source stale/recompile behavior;
- one-use scoped maintenance review/approval/revocation without hard-policy or availability bypass;
- automated contract/integration tests, a credential-gated real-provider project end-to-end, and an opt-in live tuning runner that suppresses every proposed tool effect.

The remaining coverage limit is imposed by OMP 18.1.19: restricted children remove extensions, and broad shell/evaluation calls expose dispatch but not every nested effect. `/policy coverage` labels both cases explicitly.

## Phase 1: package and contracts

- Initialize the TypeScript marketplace plugin without splitting packages.
- Establish `src/policy` and `src/adapters/omp` dependency boundaries.
- Define normalized actions, decisions, policy snapshots, source provenance, and audit records.
- Add provider interfaces that describe a general policy model rather than Jev-specific objects.

Acceptance: the policy module compiles without importing OMP and a host adapter can apply allow, prompt, deny, and revised-input decisions.

## Phase 2: OMP-native identity and credentials

- Register the `typesafe-ai` runtime provider.
- Implement login, logout, environment fallback, and models-list credential validation.
- Use OMP `AuthStorage` and auth-broker behavior.
- Add or upstream secret prompt metadata so key input is masked.
- Require and persist one-time profile consent for instruction egress.

Acceptance: login survives restart in the selected OMP profile; logout removes it; validation performs no paid inference. Secret prompt metadata remains an upstream goal: OMP 18.1.19 direct token input must not be assumed masked. Use a private terminal or trusted environment injection, never a recorded tuning transcript.

## Phase 3: project discovery and state

- Resolve canonical nearest-worktree project identity.
- Implement Git-root-bounded instruction discovery and subtree scoping.
- Create the separate profile-scoped policy database.
- Persist onboarding state, source digests, snapshots, and version metadata.
- Implement automatic first-project onboarding and idempotent `/policy onboard`.

Acceptance: parent instructions above the Git root are excluded, nested repositories remain isolated, and repeated onboarding produces the same active snapshot when sources are unchanged.

## Phase 4: compiler and evaluation

- Parse sources with provenance and precedence.
- Classify hard requirements, workflow obligations, advisory preferences, and unclassified semantic statements.
- Run deterministic applicability and grounded local literal-path checks before semantic evaluation, preserving conditions, exceptions, and cross-cutting prohibitions.
- Add the TypeSafe policy-model adapter, redaction, thresholding, and cached client reuse. Keep small policies in one request; preflight oversized policies into whole-rule chunks of at most 40,000 serialized bytes each and at most 64 requests, with repeated full redacted action/authorization and preserved source/heading dictionaries. Keep contiguous same-source/heading groups together when they fit.
- Run at most four calls concurrently under one overall 20-second default deadline, without retries. Any valid denial wins, otherwise any unavailability wins over prompt, and allow requires every chunk to allow under a consistent resolved model. Stop new calls on cancellation or consent loss. Preserve explicit host confirmation/fallback settings.
- Record the selected backend plus compiler/question/threshold versions in snapshots, resolved models in diagnostics, and actual matched rules separately from applicable candidates.

Acceptance: all applicable rules are covered before an aggregate allow; ambiguity follows the configured automatic default or confirmation threshold; provider failure and irreducibly oversized input follow the documented availability behavior. Chunking is conservative bounded coverage, not full global semantic equivalence: cross-chunk exceptions and dependencies can change outcomes, including extra false denials. No improved live accuracy is claimed.

## Phase 5: current OMP adapters

- Intercept registered tools through `tool_call`.
- Record outcomes through `tool_result`.
- Gate direct shell and Python through `user_bash` and `user_python`.
- Leave host-owned utility slash commands outside policy evaluation so recovery operations such as `/login` cannot deadlock behind the evaluator they repair.
- Capture request-scoped current-turn context in `before_agent_start`; reserve explicit exact-action authorization for digest-bound direct actions and validated one-use maintenance grants.
- Gate `task` dispatch and preserve child-session lineage.
- Check workflow obligations at session stop.

Acceptance: enabled registered tools in the main session and unrestricted subagents are evaluated before execution; routine inspection skips remote evaluation by default while grounded local path protections remain active, explicit remote-coverage settings are honored, and restricted children are visibly labeled dispatch-only.

## Phase 6: coverage and operator UX

- Implement `/policy status`, `/policy coverage`, `/policy onboard`, review, and `/policy audit [1–100]`.
- Report enforced, dispatch-gated, advisory, and uncovered surfaces for the active session.
- Use OMP status and notification APIs for onboarding and degraded-state messages.
- Produce redacted audit records separating raw provider evidence, adapter thresholds, final confirmation, actual rule matches, and source provenance.
- Offer exact one-use maintenance review/approval/revocation only for eligible uncertain project-local proposals; keep hard denials, incomplete intent, and unavailable evaluation blocking.
- Never silently rewrite native OMP approval configuration.

Acceptance: unsupported or bypassable surfaces cannot appear as enforced, and remote-provider loss is immediately visible.

## Phase 7: behavioral verification

Verification exercises both adapters and the actual boundaries:

- automated runtime-harness scenarios cover registered tool decisions, tool outcomes, direct shell, direct Python, authorization redaction, audits, and the one-continuation workflow invariant;
- project-isolation tests cover nearest nested worktrees, `.git` files, symlink canonicalization, dependency exclusions, and subtree applicability;
- persistence tests cover file modes, migration idempotence, transactional rollback, consent, stale state, snapshots, and redacted audits;
- an actual OMP 18.1.19 TUI session loads the extension, shows an active snapshot through `/policy status`, intercepts a direct shell command, and returns the synthetic blocked result;
- `testing/e2e/provider-project.ts` creates and onboards a temporary Git project, validates the live TypeSafe models endpoint, sends one redacted policy evaluation, and reports only decision metadata and usage.

The provider end-to-end requires `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE`; it is intentionally separate from the default offline test suite.

`testing/e2e/policy-tuning.ts` is a separate opt-in feedback tool, invoked with `bun run tune:policy --live`. It drives real runtime handlers and TypeSafe in disposable fixtures while suppressing all proposed tool execution. It accepts a labeled corpus, repeat count, optional additional stress rules, and an output path, and saves redacted machine-readable evidence. Mismatches and unassessed outcomes fail the run; unavailable denials never count as correct classifications.

Follow [Policy Tuning](tuning.md) for frozen rule-derived labels, paired challengers, repeated development trials, a separate held-out corpus, minimal causal fixes, deterministic regression coverage, safe native smoke, and versioned promotion/rollback. This is a procedure and tooling description, not a claim of new live revalidation. Native OMP observations and handler-runner scores must name the exercised revision and remain separate; no adversarial proposed effect should execute during tuning.

## Phase 8: upstream OMP PolicyGate

Propose an additive, profile-trusted process-wide API:

```ts
pi.registerPolicyGate(async action => decision);
```

Required semantics:

- invoked from the central approval/action path before effects;
- active in main, unrestricted, and restricted sessions;
- preserves parent-session lineage;
- covers registered tools and explicit direct core mutations;
- exposes resolved action metadata and targets;
- supports allow, prompt, deny, and revised input;
- has bounded execution time;
- fails closed for write/exec when headless;
- cannot be registered by project-local extensions.

The marketplace plugin should feature-detect this capability. On supporting OMP versions it upgrades affected surfaces from dispatch-only or uncovered to enforced. Older versions continue operating with an accurate coverage report rather than requiring a fork.
