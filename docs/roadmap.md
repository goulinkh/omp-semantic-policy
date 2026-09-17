# Implementation Roadmap

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

Acceptance: login survives restart in the selected OMP profile; logout removes it; validation performs no paid inference; secret input is not echoed.

## Phase 3: project discovery and state

- Resolve canonical nearest-worktree project identity.
- Implement Git-root-bounded instruction discovery and subtree scoping.
- Create the separate profile-scoped policy database.
- Persist onboarding state, source digests, snapshots, and version metadata.
- Implement automatic first-project onboarding and idempotent `/policy onboard`.

Acceptance: parent instructions above the Git root are excluded, nested repositories remain isolated, and repeated onboarding produces the same active snapshot when sources are unchanged.

## Phase 4: compiler and evaluation

- Parse sources with provenance and precedence.
- Classify hard requirements, workflow obligations, advisory preferences, ambiguity, and conflicts.
- Run deterministic rules before semantic evaluation.
- Add the TypeSafe policy-model adapter, redaction, thresholding, and local cache.
- Pin the starting backend version and include all compiler/question/threshold versions in snapshots.

Acceptance: explicit prohibitions can block locally; ambiguous instructions prompt review; provider failure follows the documented availability behavior.

## Phase 5: current OMP adapters

- Intercept registered tools through `tool_call`.
- Record outcomes through `tool_result`.
- Gate direct shell and Python through `user_bash` and `user_python`.
- Gate built-in command dispatch through `input`.
- Capture user authorization in `before_agent_start`.
- Gate `task` dispatch and preserve child-session lineage.
- Check workflow obligations at session stop.

Acceptance: every registered tool in the main session and an unrestricted subagent is seen before execution; restricted children are visibly labeled dispatch-only.

## Phase 6: coverage and operator UX

- Implement `/policy status`, `/policy coverage`, `/policy onboard`, and review flows.
- Report enforced, dispatch-gated, advisory, and uncovered surfaces for the active session.
- Use OMP status, widget, and notification APIs for onboarding and degraded-state messages.
- Produce redacted audit records explaining the policy clauses and evidence behind decisions.
- Never silently rewrite native OMP approval configuration.

Acceptance: unsupported or bypassable surfaces cannot appear as enforced, and remote-provider loss is immediately visible.

## Phase 7: behavioral verification

Exercise the actual OMP runtime rather than relying only on unit tests:

- block a built-in write before filesystem mutation;
- revise an eligible tool input;
- enforce an unrestricted child call;
- demonstrate restricted-child dispatch-only status;
- block direct interactive shell and Python commands;
- gate a slash command with a direct core mutation;
- show that an allowed broad execution action has no nested interception;
- prove Git-root and nested-repository isolation;
- edit a policy source and require recompilation before another high-impact action.

Retain regression tests only for durable observable contracts; keep exploratory probes under the experiment record.

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
