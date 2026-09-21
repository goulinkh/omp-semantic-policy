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

Deterministic grounded path protections run before remote-coverage filters. Semantic evaluation handles the remaining applicable instructions, ambiguity, and headless workflow checks; it cannot weaken a local denial. Filtered calls skip TypeSafe, not all policy enforcement. No applicable rules can produce a local allow. Incomplete action evidence is unassessed and blocking even with a permissive confirmation default; other unavailable evaluation reaches the configured conservative fallback without becoming a violation claim. The fallback records whether semantic evaluation was disabled, login was required, credential resolution failed, evaluation failed, or the provider returned another unavailable result. If the semantic model was not needed, status reports it as not checked rather than unavailable.

The incomplete-action guard is part of semantic coverage. A filtered call still undergoes grounded local checks, then receives a coverage bypass; this lets disabled or default-excluded custom tools execute without pretending that their unknown schema was assessed. When all-tool coverage or an exact allowlist entry includes an unclassified custom tool, the incomplete guard fails closed.

## Normalized action

The implemented `PolicyAction` records:

- action identifier and timestamp;
- actor plus session and optional parent-session lineage;
- working directory;
- operation class: read, write, execute, delegate, network, workflow, internal, or unknown;
- host operation, structured input, source metadata, normalized action details, and completeness;
- normalized targets, including grounded routed-operation and delegated-dispatch evidence when available;
- interception capability: precise, dispatch-only, advisory, or absent.

Configured `toolOperations` entries classify exact custom or MCP tool names without changing built-in adapters. Their complete bounded input is retained under `details.input`; generic `path`, `directory`, `url`, `target`, and `repository` fields become normalized targets. These actions remain dispatch-only because the host hook gates dispatch but cannot contain nested effects.

The evaluation context separately carries headless state and optional authorization and snapshot references. Ordinary `before_agent_start` text starts request-scoped with `explicit: false`, not blanket approval of implementation. A whole affirmative literal Run/Execute request may be host-bound to the identical complete bash command; environment overrides, another working directory, and extra command segments do not inherit that authorization. Matching uses original input, not redacted summaries. Direct user actions and host-validated one-use maintenance grants are also exact-action scoped and bound to the full action digest. Authorization does not override an absolute applicable prohibition.

Shell authorization additionally carries optional `requestContext`: at most two recent human user messages and one preceding assistant text proposal, in chronological order, bounded to 4,000 characters and 64 linked session entries. It is collected at `before_agent_start` for registered `bash` calls and from the current branch for direct `user_bash` calls. Short confirmations and refusals remain conversational evidence, not host-verified grants. Agent-attributed user messages, thinking, tool results (including tool-based confirmation selections), and unrelated history are excluded. Oversized or nontext user input and compaction/reset boundaries mark context partial instead of substituting an older approval. Session initialization clears retained context; ordinary non-shell calls do not receive this history.

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
2. **Workflow requirement** — sequencing and completion obligations checked at relevant transitions and at session stop in headless sessions.
3. **Advisory preference** — style or preference guidance.
4. **Semantic statement** — statements that do not safely fit the first three classes.

Classification retains headings, explicit procedural introductions, source provenance, precedence, and conservative phase applicability. Positively recognized historical reports, measured-result tables, and navigation prose are not instructions; live constraints and unfamiliar policy remain candidates even in historical sections. Narrow, unconditional literal-path prohibitions can compile to local enforcement; procedure-scoped conditions, permissions, and exceptions remain semantic rather than becoming universal bans. Writing documentation that mentions a command is not executing that command. The local grammar is deliberately not a general natural-language or shell interpreter, and procedure membership remains a semantic judgment.

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

Repeated registered-tool deliveries share one in-flight or settled policy assessment within the same OMP host session and runtime configuration, including separate source and bundle copies. The identity combines tool-call ID and tool name; changed intent, snapshot, authorization, consent, or confirmation settings cannot reuse an earlier approval. Result ownership records each outcome once. Shared maintenance state lets the registered command resolve the proposal created by another copy. The coordinator retains at most 512 completed actions and releases session state on teardown. This is not cross-process deduplication or an exactly-once guarantee for host tool execution; direct shell/Python events have no stable dispatch IDs.

## Project identity and scope

Project identity is the real path of the nearest enclosing Git worktree. Discovery must stop at that root. Nested repositories are separate projects. Nested `AGENTS.md` files are subtree-scoped; user-global instructions are a separate source class rather than an ancestor directory.

Supplemental standards are discovered without repository-specific path conventions. The OMP adapter gives the active/default model a bounded, redacted set of text-document previews plus the effective runtime prompt, which can expose project skills and MCP instructions. Model output is advisory: selected files must match the inventory and resolve to regular files inside the Git root, while runtime excerpts must be exact substrings of the supplied context. Symlinks, nested repositories, generated/dependency directories, ungrounded paths, and invented excerpts are rejected.

The resulting files are loaded locally as project-wide sources with their own provenance. Runtime excerpts use synthetic provenance and never claim a filesystem path. Selection is cached by grounded input, but selected files are reread before compilation. If no model or credential is available, inference fails, or output is invalid, onboarding continues with deterministic profile and `AGENTS.md`/`CLAUDE.md` discovery.

`/policy link @<file-or-directory>` is the explicit exception to in-root discovery. It canonicalizes and persists a source path against the real Git project identity. A linked file, or supported text documents recursively found in a linked directory, becomes project-wide policy. Onboarding rereads these sources in the current and future sessions so content changes produce a new snapshot; missing persisted paths contribute no source until they return.

No policy data may be keyed only by the current directory string. Symlink resolution and worktree identity are required to prevent duplicate or cross-project state.

## Storage

- Credentials: OMP `AuthStorage`, with `TYPESAFE_API_KEY` as the environment fallback.
- Project state, linked source paths, immutable snapshots, consent, and redacted audits: profile-scoped `policy.db` under `getAgentDir()`.
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
- only applicable instruction statements, normalized action evidence (including proposed mutations and bounded original/before-after context), and redacted authorization with bounded shell request context are transmitted;
- complete relevant policy coverage through one bounded request for small policies or conservative whole-rule chunk aggregation for oversized policies.

File mutation evidence includes bounded write content, freeform patches, replacement pairs, and structured edit batches. Missing or oversized mutation intent marks the action incomplete rather than presenting a target-only action as complete.

After local, coverage, consent, and credential gates pass, native local `write`/`edit` evaluations add optional `details.sourceContext` with `phase: "before"`. Only the action's project-contained file targets are inspected; routed and custom tools are excluded. Canonical paths, existing local read prohibitions, no-follow regular-file opens, bounded reads, and identity checks guard inspection. Small files carry their full original text; larger files use line-numbered windows around known edit locations. This is source evidence, not a simulated patch result or an instruction source.

The same inspected original supplies optional `details.mutationContext` with `phase: "proposed"`. Each file reports included, partial, or unavailable evidence. Included hunks pair original `before` and proposed `after` ranges with 1-based `startLine`, `lineCount`, and exact text; a zero count denotes the gap before that line. Supported projections include existing-file writes, exact sequential replacement batches, current-hash numeric hashline ranges and insertions, and exact native unified updates. No edit session or proposed tool runs during assessment. Stale hashes, register/block/move operations, ambiguous selectors, and cases requiring native repair remain unavailable rather than fabricating a result. These hunks describe hypothetical changes, not successful application or instructions.

Inspection is capped at 256 KiB per file and eight target entries. Original and mutation context share an 8 KiB serialized budget and remaining action-evidence capacity, with room reserved for original mutation inputs. Large-file source excerpts use at most 16 location windows with three neighboring lines; mutation evidence includes at most 32 hunks. Missing, unsupported, oversized, ambiguous, or inaccessible evidence is reported as unavailable; omitted ranges or hunks are marked partial. An existing empty file is distinct from an absent one. Optional context can be omitted when the evidence budget is exhausted; it does not change action completeness or confirmation settings. New dispatches reread their targets, while duplicate deliveries share the original assessment. Consent is checked before inspection and again before provider evaluation. Shared redaction applies to all source excerpts, proposed hunks, and shell conversation text; these bodies remain excluded from audit records and denial feedback.

### Bounded policy requests

The planner losslessly interns source/precedence and heading metadata; it never truncates or drops rule statements. Each serialized provider state is at most 40,000 UTF-8 bytes, including partition metadata for multi-request plans. Every chunk repeats the full redacted action and authorization and preserves the source and heading dictionaries. Contiguous rules with the same source and heading stay together when their complete group fits an empty chunk; otherwise the planner splits only between whole rules. Small policies retain one primary request without partition metadata.

All chunks are planned before any provider call. More than 64 chunks, or an indivisible rule or repeated action/authorization and dictionary state that cannot fit the per-request bound, makes the evaluation unavailable before egress. Chunking therefore provides bounded coverage, not unlimited context capacity.

At most four SDK calls run concurrently under one overall evaluation deadline (`timeoutMs`, default 20 seconds), without retries. Caller cancellation propagates to in-flight calls; cancellation or consent loss prevents new calls. Each response uses independent 0.5 allow-confidence and 0.8 deny-confidence cutoffs, plus a 0.8 hard-violation cutoff. Every semantic denial, including a hard override, requires nonempty validated applicable-rule attribution. Citation-choice confidence at least 0.65 establishes attribution directly. When an otherwise blocking assessment selects a known candidate below that cutoff, one independent Noul check asks whether the action violates that specific rule. It receives the unchanged redacted chunk and the candidate's resolved statement, source, and heading context; other policy remains available for exceptions. A valid response from the same resolved model with probability at least 0.8 grounds the citation. Missing or invalid candidates never trigger verification.

All primary chunks reserve slots in the shared 64-call evaluation budget before any verification can run. Each chunk can use at most one additional slot, without increasing concurrency or extending the deadline. Budget exhaustion, failed transport, or invalid verification makes the chunk unavailable; a valid verification below 0.8 leaves the denial ungrounded. Ungrounded denial becomes `prompt` with `decisionBasis: "ungrounded-denial"`; automatic acceptance remains unchanged. Diagnostics distinguish `attributionConfidence`, `attributionCandidateRuleId`, and `attributionVerificationProbability`; candidate IDs are not established matches. Valid verification usage is included in totals. The OMP evaluator also enforces attribution validity at the provider boundary.

Aggregation uses `all-allow-any-deny`: any valid chunk denial wins even if another chunk fails; otherwise any unavailable chunk makes the aggregate unavailable; otherwise any prompt yields a prompt. Allow requires every planned chunk to be assessed as allow, covering every applicable rule. Different resolved models make the aggregate unavailable unless a valid denial is decisive. SDK errors are retained per chunk, and usage sums valid responses.

This user-approved conservative strategy is not globally equivalent to evaluating all rules together. Grouping reduces avoidable separation but cannot preserve every cross-chunk permission, exception, dependency, or conflict. Outcomes can differ, including extra false denials; bounded rule coverage does not establish improved live accuracy. Provider aggregation does not override the host's explicit confirmation or fallback settings described below.

Multi-request diagnostics use `decisionBasis: "chunk-aggregation"` without inventing aggregate `rawChoice` or `rawConfidence`. Each chunk records its zero-based index, whether it was attempted, applicable and matched rule IDs, serialized-state SHA-256 digest, and single-request diagnostics. Aggregate citations come from denying chunks for deny, prompting chunks for prompt, or all matched rules for allow, never all candidate IDs. `stateBytes` is the largest planned wire state; aggregation metadata records strategy, total/assessed/attempted chunk counts, concurrency limit, completeness, original state bytes, and total planned state bytes. Single-request diagnostics remain compatible.

Aggregate confidence is the minimum chunk confidence for allow/prompt, or the confidence of the denying chunk with the highest hard-violation score for deny. For denial, aggregate `hardViolationProbability` considers only grounded denying chunks; otherwise it is the maximum assessed chunk score. An ungrounded high score cannot explain another chunk's grounded denial. These extrema are routing statistics, not a calibrated joint probability or a new raw model answer. For a mixed-model denial, the top-level model identifies that decisive denying response; individual models remain visible in chunk diagnostics.

## Availability behavior

Local deterministic rules remain available without the remote provider. Defaults leave routine inspection outside semantic checks and automatically accept confirmation requests without dialogs:

- reads are allowed unless a deterministic rule protects the target;
- adapted model allows and grounded denials remain authoritative; ungrounded denials follow confirmation settings;
- model confirmation requests use `confirmationDefault` (`approve` by default), without a dialog in automatic mode;
- `confirmationThreshold: 1` is the runtime default and keeps checked tools and direct actions automatic; values below `1` opt into prompting at or above that confidence, and `0` prompts for every uncertain checked action;
- interactive session-stop checks are skipped entirely because any post-response extension work can race input intended for the next draft; headless checks use `confirmationDefault` without a dialog;
- an unavailable semantic evaluator uses the same confirmation default and is treated as maximum-confidence uncertainty when interactive confirmation is enabled;
- any remaining prompt denies when the host cannot present confirmation;

Checked unknown tools follow the same configured behavior. Uncertainty and provider unavailability are not compliance judgments. The default deliberately accepts confirmation requests, including ungrounded model denials and unavailable-evaluator fallbacks in interactive and headless sessions. `confirmationDefault: "deny"` opts into fail-closed automatic resolution. Neither setting overrides grounded policy denials or incomplete-action guards. Existing explicit settings are preserved. Standalone `evaluateSnapshotPolicy` calls that omit confirmation settings also default to automatic acceptance; the OMP runtime passes its settings. Missing credentials remain identified as `login required`, with recovery through `/login typesafe-ai` or `TYPESAFE_API_KEY`.

For unknown registered tools, coverage determines whether incompleteness is enforced: excluded names receive a coverage bypass after local checks, while enabled unclassified names fail closed. An explicit `toolOperations` classification supplies a complete bounded representation for semantic assessment.

Credential redaction preserves quoted empty fields and delimiters while withholding nonempty values. A redacted value is not evidence of emptiness or proof of a live credential. Policy questions assess the proposed action, not quoted examples, and claims of testing or an empty environment do not override applicable prohibitions. This remains semantic enforcement, not a comprehensive shell parser or a guarantee against model misclassification.

Scoped maintenance is a separate one-use authorization path, not a fail-open policy setting. `/policy maintenance` shows the last eligible assessed-uncertain project-local install/link or plugin-lockfile proposal; `/policy maintenance approve <action-id>` binds one identical retry to its full input digest, session, project, and snapshot. `/policy maintenance revoke` clears it. Only the exact supported install/link commands and project-local `plugin/omp-plugins.lock.json` object writes qualify. Local or semantic denials, incomplete intent, and unavailable evaluation cannot be approved through this flow. The retry still undergoes evaluation; there is no offline hard-policy bypass. See [Policy Tuning](tuning.md#scoped-maintenance-not-a-policy-bypass) for the operator procedure.

## Session presentation

Policy state uses OMP's native `status` segment rather than a separate hook-status row. The plugin adds that segment before the TUI is constructed and exposes `showStatus` through OMP plugin settings. Automatic onboarding runs on OMP's managed timer so model-assisted discovery never blocks startup input routing. Manual onboarding clears the submitted command, publishes a start notification, displays an animated above-editor progress widget, switches to `⛨ onboarding…`, and returns control to the TUI before discovery starts. An exact `/policy onboard` draft is recovered during initialization if startup command routing consumed its first Enter. Onboarding operations are serialized; completion removes the spinner, publishes the compact final report, and repaints an empty composer without discarding a new draft typed during onboarding.

Tool denials return action-bound error text through OMP's `tool_call` result, not detached notifications that could appear beside another parallel call. Cards separate the tool and redacted action summary, the decisive rule and short source path, and a next step. Negative heading context is visibly labeled as a prohibition, not presented as a positive instruction. Action IDs, rule hashes, probability scores, full provenance, and confirmation diagnostics remain in `/policy audit`. Code, proposed write bodies, original source excerpts, and environment values are omitted from feedback. Confirmation blocks remain distinct from established rule conflicts. No alternate-tool bypass is suggested. Direct-action and headless workflow outcome notifications remain controlled by `showViolationFeedback`; accepted actions stay silent. The `⛨` mark identifies policy output. Defaults remain `confirmationThreshold: 1` and `confirmationDefault: approve`; existing settings are preserved.

## Enforced OMP surfaces

- enabled registered tool calls through `tool_call`, with outcomes observed through `tool_result`;
- direct `!` shell and `$` Python execution through `user_bash` and `user_python`;
- OMP utility slash commands intentionally bypass semantic evaluation so login, model, session, and configuration recovery remain available;
- project workflow completion through `session_stop` in headless sessions, limited to one continuation per turn; interactive sessions skip this post-response hook so the next draft cannot lose input;
- unrestricted child sessions when OMP propagates the extension.

Registered tool-call remote coverage defaults to `bash,eval,python,write,edit,task,hub,browser,computer,debug`. Routine inspection and bookkeeping (`glob`, `lsp`, `read`, `grep`, `todo`, `ask`, and `web_search`) skip semantic evaluation unless explicitly enabled. Custom and MCP tool names also require explicit inclusion. Grounded local read/write path prohibitions run even for filtered calls; this does not provide semantic coverage for arbitrary excluded-tool behavior. In particular, excluded LSP operations may mutate sources beyond locally represented targets.

`enabledToolCalls` is a comma-separated exact-name remote-evaluation allowlist; add `glob` to the list to enable its semantic checks. An explicitly empty value disables remote evaluation for registered tool calls. `disabledToolCalls` takes precedence when a name appears in both settings, without disabling grounded local path checks. These settings affect registered `tool_call` events only; direct `!` shell and `$` Python gates and headless workflow gates remain independently enforced.

`toolOperations` accepts exact `name=operation` mappings (or a JSON object) for custom and MCP tools. Classifications may be `read`, `write`, `execute`, `delegate`, `network`, `workflow`, `internal`, or `unknown`; built-in classifications take precedence. Covered unclassified names remain incomplete and blocking.

Native `lsp` and `write` to the exact device path `xd://lsp` share the `lsp` coverage setting. Routed calls retain their actual `write` host provenance, but enabling or disabling `write` does not change LSP coverage. Ordinary file writes and other device paths still follow `write` coverage.

Actions without applicable rules already skip semantic evaluation. Do not cache decisions solely by command text: policy snapshots, authorization, and external state can change between otherwise identical actions.

Broad shells and restricted children remain dispatch-gated: their enclosing action is checked, but nested effects cannot be intercepted individually.

## Threat boundary

The plugin can enforce only at events the host emits before effects. It cannot provide process containment after allowing arbitrary shell or evaluation code. It also cannot defend against a malicious trusted project extension executing outside registered tool calls. Coverage must therefore be reported per surface and never described as a sandbox.

## Feedback and promotion

Use [Policy Tuning](tuning.md) to freeze rule-derived expectations, run paired repeated probes, diagnose context/coverage/local/model/threshold/provider failures, and promote only versioned evidence. The opt-in live runner invokes real runtime handlers with TypeSafe in disposable fixtures but never executes proposed tool bodies. Native OMP smoke checks exercise only harmless local actions and establish separate host-integration evidence. Neither corpus results nor parent-task dispatch checks establish containment of restricted children or arbitrary nested effects.
