# Architecture

## Product boundary

OMP Semantic Policy is a semantic policy plane, not a sandbox. It decides whether a proposed OMP action is consistent with standing instructions and current user authorization. OMP remains responsible for exposing a pre-effect interception point and enforcing the returned decision.

The package keeps host, provider, and policy concerns separated:

```text
src/policy/             compiler, snapshots, applicability, evaluation, decisions
src/adapters/omp/       OMP events, commands, project discovery, SQLite persistence
src/adapters/typesafe/  provider payload redaction, API adapter, OMP authentication
```

`src/policy` does not import OMP, TypeSafe, SQLite, filesystem, environment, or UI modules. It is exported for reuse. A separate package remains deferred until a second consumer justifies it.

## Action pipeline

```text
host event
  -> host-specific parser
  -> normalized PolicyAction
  -> deterministic rules
  -> semantic policy-model evaluation when needed
  -> allow | prompt | deny | revise
  -> host enforcement and audit record
```

Deterministic checks run first and allow a snapshot action only when no compiled rule applies. Model evaluation handles semantic matching, ambiguity, hard constraints, and workflow checks; it cannot weaken an earlier deterministic result. Provider unavailability reaches a conservative fallback.

## Normalized action

The implemented `PolicyAction` records:

- action identifier and timestamp;
- actor plus session and optional parent-session lineage;
- working directory;
- operation class: read, write, execute, delegate, network, workflow, internal, or unknown;
- host operation, structured input, and source metadata when available;
- normalized targets;
- interception capability: precise, dispatch-only, advisory, or absent.

The evaluation context separately carries headless state and optional authorization and snapshot references. The OMP runtime populates both from `before_agent_start` and the active project snapshot without coupling actions to storage.

The engine does not depend on OMP tool names. The OMP adapter translates `write`, `edit`, `bash`, `eval`, `task`, MCP calls, and future tools into the shared operation vocabulary.

## Decisions

```ts
type PolicyDecision =
  | { effect: "allow"; evidence: DecisionEvidence }
  | { effect: "prompt"; reason: string; evidence: DecisionEvidence }
  | { effect: "deny"; reason: string; evidence: DecisionEvidence }
  | {
      effect: "revise";
      input: Readonly<Record<string, unknown>>;
      reason: string;
      evidence: DecisionEvidence;
    };
```

Decision evidence identifies the evaluator, evidence class, and matched rule identifiers. Every snapshot records model, compiler, question, and threshold versions. User-facing explanations stay concise; durable audit records contain redacted target summaries, decisions, and outcomes.

## Instruction classification

Compiled instructions use four behavioral classes:

1. **Hard requirement** — explicit constraints and prohibitions.
2. **Workflow requirement** — sequencing and completion obligations checked at relevant transitions and session stop.
3. **Advisory preference** — style or preference guidance.
4. **Semantic statement** — statements that do not safely fit the first three classes.

Classification retains source provenance and precedence. Enforcement uses the semantic model when applicable rules exist; ambiguity or provider failure requires review rather than silently becoming a hard denial.

## Policy snapshot

A snapshot is immutable and includes:

- normalized instruction sources and provenance;
- compiled rules and their classifications;
- project identity and source boundaries;
- policy-model identifier and version;
- compiler version;
- question/prompt version;
- threshold version;
- creation time and content-addressed identity.

When a policy source is modified, the old snapshot governs the mutation that changes it. A new snapshot must be compiled before the next high-impact action.

## Project identity and scope

Project identity is the real path of the nearest enclosing Git worktree. Discovery must stop at that root. Nested repositories are separate projects. Nested `AGENTS.md` files are subtree-scoped; user-global instructions are a separate source class rather than an ancestor directory.

Supplemental standards are discovered without repository-specific path conventions. The OMP adapter gives the active/default model a bounded, redacted set of text-document previews plus the effective runtime prompt, which can expose project skills and MCP instructions. Model output is advisory: selected files must match the inventory and resolve to regular files inside the Git root, while runtime excerpts must be exact substrings of the supplied context. Symlinks, nested repositories, generated/dependency directories, ungrounded paths, and invented excerpts are rejected.

The resulting files are loaded locally as project-wide sources with their own provenance. Runtime excerpts use synthetic provenance and never claim a filesystem path. Selection is cached by grounded input, but selected files are reread before compilation. If no model or credential is available, inference fails, or output is invalid, onboarding continues with deterministic profile and `AGENTS.md`/`CLAUDE.md` discovery.

No policy data may be keyed only by the current directory string. Symlink resolution and worktree identity are required to prevent duplicate or cross-project state.

## Storage

- Credentials: OMP `AuthStorage`, with `TYPESAFE_API_KEY` as the environment fallback.
- Project state, immutable snapshots, consent, and redacted audits: profile-scoped `policy.db` under `getAgentDir()`.
- Session entries: unsuitable for durable project state.
- Policy state does not add private tables to OMP's `agent.db`.

The policy database parent directory is mode `0700` and the database is mode `0600`. WAL, foreign keys, versioned transactional migrations, and project-root keys isolate durable state.

## Provider abstraction

The policy engine must treat Jev as one implementation of a broader policy-model contract. A provider evaluates normalized policy questions and returns a decision-oriented result with confidence and rationale sufficient for thresholding and audit. Provider-specific response shapes stay behind an adapter.

The first provider integration is TypeSafe:

- provider name: `typesafe-ai`;
- OMP-native `/login typesafe-ai` and `/logout typesafe-ai`;
- interactive login accepts the token directly and returns it to OMP `AuthStorage`, which persists it with the other provider credentials in `agent.db`;
- validation using the models-list endpoint, not paid inference;
- `TYPESAFE_API_KEY` environment fallback when it is actually set, without registering the environment-variable name as a literal credential;
- one-time profile consent before remote egress;
- redaction before egress;
- only applicable instruction statements, normalized action metadata, and redacted current-turn authorization are transmitted;
- large applicable rule sets are partitioned into bounded requests without dropping rules, then combined conservatively.

## Availability behavior

Local deterministic rules remain available without the remote provider. If semantic evaluation is unavailable:

- reads are allowed unless a deterministic rule protects the target;
- model `allow` and `deny` decisions remain authoritative;
- model confirmation requests automatically use `confirmationDefault` (`deny` by default) unless their confidence reaches the configured `confirmationThreshold`;
- `confirmationThreshold: 1` disables confirmation dialogs, while `0` keeps the user in the loop for every confirmation request;
- an unavailable semantic evaluator uses the same confirmation default and is treated as maximum-confidence uncertainty when interactive confirmation is enabled;
- any remaining prompt denies when the host cannot present confirmation;

Unknown tools follow the same conservative behavior. Fallback text explicitly says the action was not classified as compliant or noncompliant. It must not present provider unavailability as evidence that a value—such as an empty credential field—is a policy violation. Missing credentials are identified separately as `login required`; feedback directs the user to `/login typesafe-ai` or `TYPESAFE_API_KEY`. Credential-resolution and provider-evaluation failures have distinct safe diagnostics.

## Session presentation

Policy state uses OMP's native `status` segment rather than a separate hook-status row. The plugin adds that segment before the TUI is constructed and exposes `showStatus` through OMP plugin settings. Automatic onboarding runs on OMP's managed timer so model-assisted discovery never blocks startup input routing. Manual onboarding clears the submitted command, publishes a start notification, displays an animated above-editor progress widget, switches to `⛨ onboarding…`, and returns control to the TUI before discovery starts. An exact `/policy onboard` draft is recovered during initialization if startup command routing consumed its first Enter. Onboarding operations are serialized; completion removes the spinner, publishes the compact final report, and repaints an empty composer without discarding a new draft typed during onboarding.

Non-allow decisions emit durable session feedback before host enforcement or confirmation. The `⛨` mark identifies the extension across status text, `/policy` output, notifications, confirmation dialogs, and blocked-action results. Feedback uses theme-native criticality backgrounds: denial uses the error surface, confirmation uses the pending surface, and revision uses the custom-message surface. `showViolationFeedback` is enabled by default and can be disabled through OMP plugin settings. `confirmationDefault` selects `deny` or `approve`; `confirmationThreshold` enables confirmation at or above a confidence from `0` through `<1`, while `1` keeps operation fully automatic. The status segment distinguishes an active snapshot from a disabled, unavailable, or login-required semantic evaluator.

## Enforced OMP surfaces

- registered tool calls through `tool_call`, with outcomes observed through `tool_result`;
- direct `!` shell and `$` Python execution through `user_bash` and `user_python`;
- OMP utility slash commands intentionally bypass semantic evaluation so login, model, session, and configuration recovery remain available;
- project workflow completion through `session_stop`, limited to one continuation per turn;
- unrestricted child sessions when OMP propagates the extension.

Registered tool-call coverage is configurable without changing the defaults. Empty `enabledToolCalls` and `disabledToolCalls` values evaluate every registered tool call. A non-empty `enabledToolCalls` value is a comma-separated exact-name allowlist; calls outside it bypass semantic evaluation. `disabledToolCalls` is a comma-separated exact-name denylist for evaluation and takes precedence when a name appears in both settings. These settings affect registered `tool_call` events only; direct `!` shell, `$` Python, and workflow gates remain independently enforced.

Broad shells and restricted children remain dispatch-gated: their enclosing action is checked, but nested effects cannot be intercepted individually.

## Threat boundary

The plugin can enforce only at events the host emits before effects. It cannot provide process containment after allowing arbitrary shell or evaluation code. It also cannot defend against a malicious trusted project extension executing outside registered tool calls. Coverage must therefore be reported per surface and never described as a sandbox.
