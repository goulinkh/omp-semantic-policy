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
- Use OMP's active/default model to identify supplemental standards from bounded, redacted project text previews and effective skill/MCP runtime context; do not encode repository-specific standards paths.
- Treat model selections as untrusted references: accept only inventoried in-root regular files and exact runtime-context excerpts.
- Fall back to deterministic profile and `AGENTS.md`/`CLAUDE.md` sources when the model, credentials, completion, or response is unavailable.
- Show manual onboarding progress immediately and publish the final snapshot report.
- Put persistent policy state in OMP's native status segment, not a separate footer row; expose the default-on `showStatus` plugin setting.
- Emit session feedback for deny, prompt, and revise decisions by default; expose `showViolationFeedback` to make it silent.
- Keep default decisions automatic: `confirmationDefault` is `deny` and `confirmationThreshold` is `1`. Compliant checked actions pass; violations, unresolved uncertainty, and unavailable evaluation block. Prompt mode is opt-in through a threshold below `1`; `0` prompts on every uncertain checked action. Preserve explicit overrides, including deliberately configured fail-open approval.
- Default registered semantic tool checks to `bash,eval,python,write,edit,task,hub,browser,computer,debug`. Routine inspection and bookkeeping, including `glob` and `lsp`, require opt-in through `enabledToolCalls`. Grounded local path protections still run on filtered calls. Native LSP and exact `write` calls to `xd://lsp` share remote LSP coverage without rewriting host provenance. An explicitly empty allowlist checks all tools; `disabledToolCalls` takes precedence for remote evaluation. Direct shell/Python and workflow checks remain independent. Do not re-evaluate a stop event after its turn already received a continuation.
- Expose snapshot details through `/policy status` and `/policy review`, and recent redacted decision traces through `/policy audit [1–100]`.
- Use the account's production alias `jev-latest`; the live models endpoint on 2026-09-17 exposed `jev-latest` and `jev-preview`, not the researched `jev-1.13.0` identifier.
- Version model, compiler, policy question, and decision thresholds in every snapshot.

## Isolation

- Identify a project by the real path of its nearest Git worktree.
- Stop project instruction discovery at the Git root.
- Treat nested repositories as separate projects.
- Apply nested `AGENTS.md` files only to their subtree.
- Keep user-global instructions separate from project ancestry.
- Store durable project state in profile-scoped `~/.omp/agent/policy.db`.
- Keep credentials in OMP `AuthStorage`; do not put policy tables into `agent.db`.

## Enforcement semantics

- Combine standing policy with current-turn request context, but do not treat ordinary user text as blanket explicit approval. It starts request-scoped with `explicit: false`; a whole affirmative literal Run/Execute request can bind only to its identical complete bash command without environment or working-directory overrides. Match original input rather than redacted summaries. Direct user actions and host-validated maintenance grants are also digest-bound exact actions. None overrides an applicable absolute ban.
- Compile hard, workflow, advisory, and semantic statements with source provenance.
- Treat workflow obligations as transition or session-stop checks.
- Send ambiguous or conflicting instructions to semantic evaluation or conservative review.
- Let the existing snapshot govern edits to its own policy sources, then recompile before later high-impact actions.
- Run deterministic applicability checks before semantic model calls.
- Compile only grounded, unconditional literal-path prohibitions into local guards; preserve conditional, exceptional, and unfamiliar policy for semantic evaluation. Run these guards before remote-coverage exclusions.
- Retain phase and heading context without discarding unrelated hard clauses. Keep all relevant permissions and exceptions in one provider state; losslessly intern repeated source and heading metadata and use validated request-local citation aliases. Refuse oversized context rather than partitioning it unsafely.
- Record provider raw choice/confidence/hard-violation probability, adapter effect, actual matched versus applicable rule IDs, source provenance, and final confirmation resolution separately.
- Offer `/policy maintenance`, `/policy maintenance approve <action-id>`, and `/policy maintenance revoke` for one identical retry of an eligible assessed-uncertain proposal. Bind the full input digest, session, project, and snapshot; limit eligibility to supported project-local install/link commands and plugin-lockfile object writes. Never use this flow to approve hard denials, incomplete intent, or unavailable evaluation.
- When semantic evaluation is unavailable, say that the action is unclassified and apply the configured confirmation behavior; do not describe provider failure as a policy violation. Distinguish disabled consent, missing login, credential resolution, and provider evaluation so the session gives the exact recovery command.

## Privacy

- Require one-time profile consent before TypeSafe instruction egress.
- Redact recognized credential assignments, bearer tokens, provider-key formats, and URL userinfo before transmission.
- Send relevant instruction material and normalized action context, not arbitrary source files.
- Make remote-evaluation unavailability visible and use conservative local fallback behavior.
- Keep tuning corpora synthetic and credential-free. Require explicit `--live` consent for the runner's real provider requests; suppress proposed tool execution regardless of the returned decision.

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
