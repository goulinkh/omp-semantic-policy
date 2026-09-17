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
- Resolve confirmation requests automatically by default: `confirmationDefault` is `deny` and `confirmationThreshold` is `1`. Users can choose automatic approval or lower the threshold to stay in the confirmation loop.
- Keep all registered tool calls enabled by default. Expose exact-name `enabledToolCalls` and `disabledToolCalls` settings for explicit coverage overrides, with disabled names taking precedence.
- Expose details through `/policy status` and `/policy review`.
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

- Combine standing policy with explicit current-turn user authorization.
- Compile hard, workflow, advisory, and semantic statements with source provenance.
- Treat workflow obligations as transition or session-stop checks.
- Send ambiguous or conflicting instructions to semantic evaluation or conservative review.
- Let the existing snapshot govern edits to its own policy sources, then recompile before later high-impact actions.
- Run deterministic applicability checks before semantic model calls.
- When semantic evaluation is unavailable, say that the action is unclassified and apply the configured confirmation behavior; do not describe provider failure as a policy violation. Distinguish disabled consent, missing login, credential resolution, and provider evaluation so the session gives the exact recovery command.

## Privacy

- Require one-time profile consent before TypeSafe instruction egress.
- Redact recognized credential assignments, bearer tokens, provider-key formats, and URL userinfo before transmission.
- Send relevant instruction material and normalized action context, not arbitrary source files.
- Make remote-evaluation unavailability visible and use conservative local fallback behavior.

## Coverage language

Every host surface is labeled as one of:

- **Enforced**: intercepted and decided before the individual effect.
- **Dispatch-gated**: the enclosing script or delegated task is checked, not every nested effect.
- **Advisory**: policy can report but not reliably prevent.
- **Uncovered**: no usable interception point exists.

The plugin must not advertise a stronger state than it can prove for the current session.

## Upstream OMP direction

Propose one process-wide, profile-trusted `PolicyGate` registration point. OMP invokes it from the central approval/action path for registered tools, restricted sessions, subagents, and direct core mutations. Project-local extensions must not be eligible to register such a gate. This preserves standalone plugin distribution without requiring users to run a fork.
