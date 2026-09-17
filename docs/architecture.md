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

Deterministic grounded path protections run before remote-coverage filters. Semantic evaluation handles the remaining applicable instructions, ambiguity, and workflow checks; it cannot weaken a local denial. Filtered calls skip TypeSafe, not all policy enforcement. No applicable rules can produce a local allow. Incomplete action evidence is unassessed and blocking even with a permissive confirmation default; other unavailable evaluation reaches the configured conservative fallback without becoming a violation judgment.

## Normalized action

The implemented `PolicyAction` records:

- action identifier and timestamp;
- actor plus session and optional parent-session lineage;
- working directory;
- operation class: read, write, execute, delegate, network, workflow, internal, or unknown;
- host operation, structured input, source metadata, normalized action details, and completeness;
- normalized targets, including grounded routed-operation and delegated-dispatch evidence when available;
- interception capability: precise, dispatch-only, advisory, or absent.

The evaluation context separately carries headless state and optional authorization and snapshot references. Ordinary `before_agent_start` text starts request-scoped with `explicit: false`, not blanket approval of implementation. A whole affirmative literal Run/Execute request may be host-bound to the identical complete bash command; environment overrides, another working directory, and extra command segments do not inherit that authorization. Matching uses original input, not redacted summaries. Direct user actions and host-validated one-use maintenance grants are also exact-action scoped and bound to the full action digest. Authorization does not override an absolute applicable prohibition.

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

Decision evidence separates actual matched rule identifiers from applicable candidate identifiers and links grounded decisive rules to source provenance. Diagnostics retain the local/coverage/semantic/unavailable path, provider raw choice/confidence/hard-violation probability, adapter effect, and final confirmation resolution/enforced effect. Every snapshot records model, compiler, question, and threshold versions; provider diagnostics additionally record the resolved response model, not only the configured alias. Durable audits contain redacted actions, authorization, decisions, and outcomes. `/policy audit [1–100]` exposes recent records; see [Policy Tuning](tuning.md) for interpretation and experimental limits.

## Instruction classification

Compiled instructions use four behavioral classes:

1. **Hard requirement** — explicit constraints and prohibitions.
2. **Workflow requirement** — sequencing and completion obligations checked at relevant transitions and session stop.
3. **Advisory preference** — style or preference guidance.
4. **Semantic statement** — statements that do not safely fit the first three classes.

Classification retains headings, source provenance, precedence, and conservative phase applicability. Narrow, unconditional literal-path prohibitions can compile to local enforcement; conditions, permissions, and exceptions must remain available to semantic assessment rather than being turned into unconditional bans. The current local grammar is deliberately not a general natural-language or shell interpreter. Applicable semantic ambiguity and provider failure remain distinct from a proven violation even when both ultimately block.

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
- complete relevant policy context in one bounded request; oversized state is reported as unavailable instead of splitting related prohibitions, permissions, and exceptions into unsafe independent chunks.

## Availability behavior

Local deterministic rules remain available without the remote provider. Defaults leave routine inspection outside semantic checks and automatically enforce checked actions without dialogs:

- reads are allowed unless a deterministic rule protects the target;
- model `allow` and `deny` decisions remain authoritative;
- model confirmation requests automatically use `confirmationDefault` (`deny` by default) unless interactive prompting is explicitly enabled and their confidence reaches the configured `confirmationThreshold`;
- `confirmationThreshold: 1` is the default automatic mode; a value below `1` opts into prompts, and `0` prompts for every confirmation request;
- an unavailable semantic evaluator uses the same confirmation default and is treated as maximum-confidence uncertainty when interactive confirmation is enabled;
- any remaining prompt denies when the host cannot present confirmation;

Checked unknown tools follow the same configured behavior. Uncertainty and provider unavailability are not compliance judgments: the automatic default denies them. `confirmationDefault: "approve"` explicitly opts into fail-open resolution; it never overrides an explicit policy denial. Existing explicit settings are preserved, so previously saved approval overrides must be removed or changed to adopt the safer defaults. Fallback text must not present provider unavailability as proof of a violation. Missing credentials are identified separately as `login required`, with recovery through `/login typesafe-ai` or `TYPESAFE_API_KEY`.

Credential redaction preserves quoted empty fields and delimiters while withholding nonempty values. A redacted value is not evidence of emptiness or proof of a live credential. Policy questions assess the proposed action, not quoted examples, and claims of testing or an empty environment do not override applicable prohibitions. This remains semantic enforcement, not a comprehensive shell parser or a guarantee against model misclassification.

Scoped maintenance is a separate one-use authorization path, not a fail-open policy setting. `/policy maintenance` shows the last eligible assessed-uncertain project-local install/link or plugin-lockfile proposal; `/policy maintenance approve <action-id>` binds one identical retry to its full input digest, session, project, and snapshot. `/policy maintenance revoke` clears it. Only the exact supported install/link commands and project-local `plugin/omp-plugins.lock.json` object writes qualify. Local or semantic denials, incomplete intent, and unavailable evaluation cannot be approved through this flow. The retry still undergoes evaluation; there is no offline hard-policy bypass. See [Policy Tuning](tuning.md#scoped-maintenance-not-a-policy-bypass) for the operator procedure.

## Session presentation

Policy state uses OMP's native `status` segment rather than a separate hook-status row. The plugin adds that segment before the TUI is constructed and exposes `showStatus` through OMP plugin settings. Automatic onboarding runs on OMP's managed timer so model-assisted discovery never blocks startup input routing. Manual onboarding clears the submitted command, publishes a start notification, displays an animated above-editor progress widget, switches to `⛨ onboarding…`, and returns control to the TUI before discovery starts. An exact `/policy onboard` draft is recovered during initialization if startup command routing consumed its first Enter. Onboarding operations are serialized; completion removes the spinner, publishes the compact final report, and repaints an empty composer without discarding a new draft typed during onboarding.

Non-allow decisions emit durable session feedback before host enforcement or confirmation. The `⛨` mark identifies the extension across status text, `/policy` output, notifications, confirmation dialogs, and blocked-action results. Feedback uses theme-native criticality backgrounds: denial uses the error surface, confirmation uses the pending surface, and revision uses the custom-message surface. `showViolationFeedback` is enabled by default and can be disabled through OMP plugin settings. `confirmationDefault` selects `deny` or `approve`; `confirmationThreshold` enables confirmation at or above a confidence from `0` through `<1`, while `1` keeps operation fully automatic. The status segment distinguishes an active snapshot from a disabled, unavailable, or login-required semantic evaluator.

## Enforced OMP surfaces

- enabled registered tool calls through `tool_call`, with outcomes observed through `tool_result`;
- direct `!` shell and `$` Python execution through `user_bash` and `user_python`;
- OMP utility slash commands intentionally bypass semantic evaluation so login, model, session, and configuration recovery remain available;
- project workflow completion through `session_stop`, limited to one continuation per turn; a repeated stop after that continuation bypasses evaluation;
- unrestricted child sessions when OMP propagates the extension.

Registered tool-call remote coverage defaults to `bash,eval,python,write,edit,task,hub,browser,computer,debug`. Routine inspection and bookkeeping (`glob`, `lsp`, `read`, `grep`, `todo`, `ask`, and `web_search`) skip semantic evaluation unless explicitly enabled. Custom and MCP tool names also require explicit inclusion. Grounded local read/write path prohibitions run even for filtered calls; this does not provide semantic coverage for arbitrary excluded-tool behavior. In particular, excluded LSP operations may mutate sources beyond locally represented targets.

`enabledToolCalls` is a comma-separated exact-name remote-evaluation allowlist; add `glob` to the list to enable its semantic checks. An explicitly empty value evaluates every registered tool call remotely when needed. `disabledToolCalls` takes precedence when a name appears in both settings, without disabling grounded local path checks. Existing explicit settings, including an empty all-tools allowlist, are preserved. These settings affect registered `tool_call` events only; direct `!` shell, `$` Python, and workflow gates remain independently enforced.

Native `lsp` and `write` to the exact device path `xd://lsp` share the `lsp` coverage setting. Routed calls retain their actual `write` host provenance, but enabling or disabling `write` does not change LSP coverage. Ordinary file writes and other device paths still follow `write` coverage.

Actions without applicable rules already skip semantic evaluation. Do not cache decisions solely by command text: policy snapshots, authorization, and external state can change between otherwise identical actions.

Broad shells and restricted children remain dispatch-gated: their enclosing action is checked, but nested effects cannot be intercepted individually.

## Threat boundary

The plugin can enforce only at events the host emits before effects. It cannot provide process containment after allowing arbitrary shell or evaluation code. It also cannot defend against a malicious trusted project extension executing outside registered tool calls. Coverage must therefore be reported per surface and never described as a sandbox.

## Feedback and promotion

Use [Policy Tuning](tuning.md) to freeze rule-derived expectations, run paired repeated probes, diagnose context/coverage/local/model/threshold/provider failures, and promote only versioned evidence. The opt-in live runner invokes real runtime handlers with TypeSafe in disposable fixtures but never executes proposed tool bodies. Native OMP smoke checks exercise only harmless local actions and establish separate host-integration evidence. Neither corpus results nor parent-task dispatch checks establish containment of restricted children or arbitrary nested effects.
