# Decision Log

## Identity

- Repository: `goulinkh/omp-semantic-policy`.
- Scope the product name to OMP semantic policy while keeping the internal policy-model contract independent of Jev.
- Jev and future model types are provider implementations behind that contract.

## Delivery shape

- Ship an installable OMP marketplace plugin first.
- Keep the policy engine free of OMP imports and export it from the same package.
- Do not create multiple packages before a second real consumer exists.
- Do not maintain an OMP fork.
- Pursue a small additive upstream OMP `PolicyGate` capability for complete coverage.

## OMP-native integration

- Register a runtime provider named `typesafe-ai` with `pi.registerProvider(...)`.
- Use OMP `AuthStorage` through `/login typesafe-ai` and `/logout typesafe-ai`; interactive login accepts the token directly and OMP stores it in the profile `agent.db` with other provider credentials.
- Validate credentials with `TypeSafeClient.models.list()` / `GET /v1/models`, avoiding paid inference.
- Support `TYPESAFE_API_KEY` as a fallback only when the environment variable contains a value; never register its name as a literal credential.
- Request secret-prompt metadata upstream so direct token input can be masked in a future OMP release.
- Use OMP marketplace updates and `marketplace.autoUpdate`; do not build a plugin updater.

## Onboarding

- Automatically onboard the active Git project at session start and session switch.
- `/policy onboard` performs the same idempotent operation manually.
- `/policy link @<file-or-directory>` canonicalizes and persists an explicit project-wide source for the current Git project; linked sources are reread during current and future session onboarding.
- Use OMP's active/default model to identify supplemental standards from bounded, redacted project text previews and effective skill/MCP runtime context; do not encode repository-specific standards paths.
- Treat model selections as untrusted references: accept only inventoried in-root regular files and exact runtime-context excerpts.
- Fall back to deterministic profile and `AGENTS.md`/`CLAUDE.md` sources when the model, credentials, completion, or response is unavailable.
- Show manual onboarding progress immediately and publish the final snapshot report.
- Put persistent policy state in OMP's native status segment, not a separate footer row; expose the default-on `showStatus` plugin setting.
- Attach tool-denial feedback to the originating result. Separate a redacted action summary, readable decisive rule and short source path, and next step; preserve negative heading meaning. Leave action IDs, rule hashes, probability scores, and full provenance in `/policy audit`. Do not emit detached tool notifications during parallel execution. Direct-action and headless-workflow outcome notifications remain controlled by `showViolationFeedback`; confirmations name the exact action and audit recovery.
- Default to automatic acceptance without dialogs: `confirmationThreshold: 1` and `confirmationDefault: approve`. Prompt decisions, including ungrounded model denials and unavailable-evaluator fallbacks, become allow in interactive and headless sessions; grounded denials and incomplete-action guards remain blocking. Interactive session-stop checks are skipped entirely because post-response work races the next draft; headless workflow checks remain automatic. Preserve explicit deny defaults and opt-in prompting below threshold `1`; selected prompts without a UI deny. Use independent 0.5 allow-confidence, 0.8 deny-confidence, 0.65 attribution, and 0.8 hard-violation cutoffs (`policy-thresholds-v3`). Every semantic denial requires validated nonempty applicable-rule attribution; otherwise record `ungrounded-denial` uncertainty.
- Default registered semantic tool checks to `bash,eval,python,write,edit,task,hub,browser,computer,debug`. Routine inspection and bookkeeping, including `glob` and `lsp`, require opt-in through `enabledToolCalls`. Grounded local path protections still run on filtered calls. Native LSP and exact `write` calls to `xd://lsp` share remote LSP coverage without rewriting host provenance. An explicitly empty allowlist disables remote evaluation for registered tool calls; `disabledToolCalls` takes precedence for listed names. Direct shell/Python and headless workflow checks remain independent. Do not re-evaluate a stop event after its turn already received a continuation.
- Bypass OMP's plain-text resolution device writes (`xd://resolve`, `xd://reject`, `xd://propose`) before action normalization regardless of `write` coverage. They finalize staged actions or submit plans, not fresh JSON-routed requests. Other device writes remain gated; staged tools retain their own coverage settings.
- Classify exact custom and MCP names through `toolOperations`, preserving complete bounded input and generic path/URL/target/repository evidence while keeping dispatch-only interception. Built-in adapters retain precedence. Apply incomplete-action guards only within semantic coverage: grounded local protections still precede filters, disabled/default-excluded unknown tools receive a coverage bypass, and enabled unclassified tools fail closed.
- Expose snapshot details through `/policy status` and `/policy review`, and recent redacted decision traces through `/policy audit [1–100]`.
- Use the account's production alias `jev-latest`; the live models endpoint on 2026-09-17 exposed `jev-latest` and `jev-preview`, not the researched `jev-1.13.0` identifier.
- Version model, compiler, policy question, and decision thresholds in every snapshot.
- Coalesce identical registered-tool assessments across duplicate source/bundle loads within one host session and configuration. Bind tool-call ID/name, full input, current snapshot, authorization, consent, and settings; reject changed same-dispatch reuse. Share one-use maintenance state and record each outcome once. Retain bounded completed history, clear lifecycle state, and never treat this as exactly-once tool execution.

## Isolation

- Identify a project by the real path of its nearest Git worktree.
- Stop project instruction discovery at the Git root.
- Treat nested repositories as separate projects.
- Apply nested `AGENTS.md` files only to their subtree.
- Keep user-global instructions separate from project ancestry.
- Store durable project state, including linked source paths, in profile-scoped `~/.omp/agent/policy.db`.
- Keep credentials in OMP `AuthStorage`; do not put policy tables into `agent.db`.

## Enforcement semantics

- Combine standing policy with current-turn request context, but do not treat ordinary user text as blanket explicit approval. It starts request-scoped with `explicit: false`; a whole affirmative literal Run/Execute request can bind only to its identical complete bash command without environment or working-directory overrides. Match original input rather than redacted summaries. Direct user actions and host-validated maintenance grants are also digest-bound exact actions. None overrides an applicable absolute ban.
- For shell decisions, preserve bounded human request/confirmation text with its preceding assistant proposal. Do not infer an exact-action grant from “yes,” treat assistant/tool output as user authority, or replace an omitted current refusal with an older approval. Missing context remains partial.
- Compile hard, workflow, advisory, and semantic statements with source provenance. Exclude positively recognized historical measurements and navigation prose without dropping live constraints or unfamiliar instructions. Preserve procedural introductions in descendant context; never turn procedure-specific restrictions into universal local guards.
- Treat workflow obligations as transition checks and, in headless sessions, session-stop checks.
- Send ambiguous or conflicting instructions to semantic evaluation or conservative review.
- Let the existing snapshot govern edits to its own policy sources, then recompile before later high-impact actions.
- Run deterministic applicability checks before semantic model calls.
- Compile only grounded, unconditional literal-path prohibitions into local guards; preserve conditional, exceptional, and unfamiliar policy for semantic evaluation. Run these guards before remote-coverage exclusions.
- Retain phase and heading context without discarding unrelated hard clauses. Losslessly intern repeated source and heading metadata and use validated request-local citation aliases. Small policies keep one primary request; oversized policies use conservative whole-rule chunks, repeating full redacted action/authorization and preserving metadata dictionaries. Keep contiguous same-source/heading groups together when they fit, and never truncate or drop rules.
- Preflight all serialized states against 40,000 bytes per request, including partition metadata, and at most 64 primary chunks. Reserve every primary call within a shared 64-call evaluation budget; citation verification uses only remaining slots and never displaces coverage. Indivisible oversized state or rules remain unavailable. Run at most four calls concurrently under one overall deadline (20 seconds by default), without retries; propagate cancellation and stop scheduling on cancellation or consent loss.
- Aggregate with all-allow/any-deny semantics: any valid denial wins despite other failures; otherwise unavailability wins over prompt, and prompt wins over allow. Allow requires complete coverage and consistent resolved models. Accept that cross-chunk exceptions and dependencies can change outcomes, including extra false denials; this is bounded coverage, not global semantic equivalence or a live-accuracy claim. This supersedes the previous single-request-only context-limit decision.
- Record provider raw choice/confidence/hard-violation probability per request, adapter effect, actual matched versus applicable rule IDs, source provenance, and final confirmation resolution separately. Multi-request diagnostics retain chunk attempts, state digests, outcomes, coverage counts, and byte totals without fabricating a single raw provider choice/confidence. Cite only decisive denying/prompting chunks or all matches for allow.
- Do not equate uncertainty about which overlapping rule to cite with uncertainty about whether any rule was violated. An otherwise blocking assessment with a known low-confidence citation gets at most one independent check of that candidate against the same redacted state. Require verification probability at least 0.8, a valid response, and the same resolved model before grounding the citation. Preserve direct attribution at 0.65 and existing decision thresholds. Record candidate rule ID, citation confidence, and verification probability separately; do not promote unknown or missing aliases. Budget exhaustion, transport failure, or invalid verification remains unavailable, not a fabricated citation.
- Preserve explicit host confirmation settings: conservative provider aggregation does not override automatic acceptance, fail-closed resolution, or opt-in interactive confirmation. None can override a grounded denial. Raw model denials without valid attribution are unresolved evidence, not grounded denials.
- Offer `/policy maintenance`, `/policy maintenance approve <action-id>`, and `/policy maintenance revoke` for one identical retry of an eligible assessed-uncertain proposal. Bind the full input digest, session, project, and snapshot; limit eligibility to supported project-local install/link commands and plugin-lockfile object writes. Never use this flow to approve hard denials, incomplete intent, or unavailable evaluation.
- When semantic evaluation is unavailable, say that the action is unclassified and apply the configured confirmation behavior; do not describe provider failure as a policy violation. Distinguish disabled consent, missing login, credential resolution, and provider evaluation so the session gives the exact recovery command.

## Privacy

- Require one-time profile consent before TypeSafe instruction egress.
- Redact recognized credential assignments, bearer tokens, provider-key formats, and URL userinfo before transmission.
- Send relevant instruction material and normalized action context, including bounded, redacted proposed mutations and original-source context from native local mutation targets. Inspect only canonical project-contained regular files after consent and existing local read protections; exclude arbitrary surrounding files and unrelated host fields. Never persist mutation or original-source bodies in policy audits. Missing or oversized mutation intent remains incomplete; optional source-context gaps are reported honestly without changing automatic acceptance.
- Pair supported edits with bounded explicit original/proposed hunks derived from the safely inspected file. Preserve native original-coordinate and sequential replacement semantics. Do not invoke native edit sessions during evaluation or invent after-state for stale, ambiguous, unsupported, or repair-dependent edits. Original and proposed context share the existing evidence budget.
- Make remote-evaluation unavailability visible and use conservative local fallback behavior.
- Keep tuning corpora synthetic and credential-free. Require explicit `--live` consent for the runner's real provider requests; suppress proposed tool execution regardless of the returned decision.
- Freeze domain-neutral regression labels and exact mutation expectations before evaluation. Offer credential-free `--offline` evidence checks separately from live scoring; offline results remain unassessed. Record false allows, false denies, unavailability, unassessed outcomes, and automatic uncertainty approvals separately. Do not count offline enforcement or provider outages as model accuracy.

## Coverage language

Every host surface is labeled as one of:

- **Enforced**: intercepted and decided before the individual effect.
- **Dispatch-gated**: the enclosing script or delegated task is checked, not every nested effect.
- **Advisory**: policy can report but not reliably prevent.
- **Uncovered**: no usable interception point exists.

The plugin must not advertise a stronger state than it can prove for the current session.

## Evidence-led tuning

- Freeze expected labels from exact rules before live calls; use paired safe/forbidden variations and a separate held-out corpus.
- Classify failures by context, coverage, local guard, applicability, model, threshold, or provider before making the smallest causal change.
- Keep counts and rate denominators visible. Unavailable denial is not a correct classification, a local denial is not a provider success, and coverage bypass is not model compliance.
- Record requested aliases and resolved models, version tuples, corpus digests, settings, latency, and request counts to distinguish code changes from provider drift.
- Separate safe native OMP smoke evidence from live runtime-handler dry-run evidence. Never execute adversarial proposals to test enforcement.
- Promote or roll back reviewed code/configuration with a versioned evidence bundle; do not rewrite old snapshots or relabel failures after seeing results. The procedure is documented in [Policy Tuning](tuning.md).

## Upstream OMP direction

Propose one process-wide, profile-trusted `PolicyGate` registration point. OMP invokes it from the central approval/action path for registered tools, restricted sessions, subagents, and direct core mutations. Project-local extensions must not be eligible to register such a gate. This preserves standalone plugin distribution without requiring users to run a fork.
