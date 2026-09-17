<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/policy-flow/policy-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/policy-flow/policy-mark-light.svg">
    <img src="docs/assets/policy-flow/policy-mark-light.svg" alt="" width="32" align="absmiddle">
  </picture>
  OMP Semantic Policy
</h1>

An [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) plugin that checks agent actions against your project instructions and authorization. [TypeSafe AI](https://typesafe.ai/) provides semantic evaluation when remote checks are enabled.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/policy-flow/policy-compilation-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/policy-flow/policy-compilation-light.svg">
  <img src="docs/assets/policy-flow/policy-compilation-light.svg" alt="Example: an AGENTS.md rule forbidding access-token logging becomes a hard rule in the compact TypeSafe policy payload. Heading context and source provenance are retained. Fenced code is not compiled." width="1400">
</picture>

## How it works

### Project onboarding

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/policy-flow/policy-onboarding-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/policy-flow/policy-onboarding-light.svg">
  <img src="docs/assets/policy-flow/policy-onboarding-light.svg" alt="Resolve the Git project, load scoped instructions, and compile an immutable policy snapshot. Source changes require a refresh before the next high-impact action." width="1400">
</picture>

### Action evaluation

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/policy-flow/policy-evaluation-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/policy-flow/policy-evaluation-light.svg">
  <img src="docs/assets/policy-flow/policy-evaluation-light.svg" alt="Capture and scope an action, evaluate locally or with TypeSafe AI, then enforce and audit. Uncertainty defaults to deny. A policy gate, not a sandbox." width="1400">
</picture>

**A policy gate, not a sandbox.** Uncertainty defaults to deny.

## Get started

Requires [Bun](https://bun.sh/) ≥1.3.14 and [OMP](https://github.com/can1357/oh-my-pi) 18.1.19. Remote evaluation also requires a [TypeSafe AI](https://typesafe.ai/) token and explicit consent.

```bash
git clone https://github.com/goulinkh/omp-semantic-policy.git
cd omp-semantic-policy
bun install --frozen-lockfile
omp plugin link .
```

Restart [OMP](https://github.com/can1357/oh-my-pi) inside a Git worktree, then:

```text
/login typesafe-ai
/policy consent on
/policy status
```

Projects onboard automatically. Use `TYPESAFE_API_KEY` instead of `/login` if preferred. Without credentials or consent, local checks and configured fallback remain active.

## Commands

### Inspect policy

- `/policy status`: Show the active snapshot and evaluator state.
- `/policy coverage`: Inspect runtime enforcement coverage.
- `/policy review`: Review the compiled rules.
- `/policy audit [1–100]`: Inspect recent redacted decisions and evidence.

### Refresh and maintenance

- `/policy onboard`: Refresh the project's policy snapshot.
- `/policy maintenance`: Review an uncertain maintenance proposal.
- `/policy maintenance approve <action-id>`: Approve one exact maintenance retry.
- `/policy maintenance revoke`: Clear the maintenance approval.

Maintenance approval applies to one exact retry, not blanket authorization.

### Remote evaluation

- `/policy consent on` / `/policy consent off`: Enable or disable remote evaluation.
- `/logout typesafe-ai`: Remove the stored credential.

## Configuration

### Status and feedback

- `showStatus` (default: `true`): Show policy state in the status bar.
- `showViolationFeedback` (default: `true`): Show feedback for denied, revised, or confirmation-required actions.

### Confirmation

- `confirmationDefault` (default: `deny`): Resolve confirmation requests when no dialog is shown. Setting `approve` opts into fail-open behavior. Explicit policy denials remain blocked.
- `confirmationThreshold` (default: `1`): Keep decisions automatic at `1`. Set below `1` to prompt for checked tools and direct actions at or above that confidence.

Session-stop workflow checks stay automatic and use `confirmationDefault`, so they do not interrupt the next prompt.

### Remote tool coverage

- `enabledToolCalls`: A comma-separated allowlist of exact tool names for remote evaluation. An empty value selects all tool calls.

  Default: `bash,eval,python,write,edit,task,hub,browser,computer,debug`.

- `disabledToolCalls` (default: empty): A comma-separated list of tool names to exclude from remote evaluation. Takes precedence over `enabledToolCalls`.

These filters only affect remote tool evaluation. Local protections, incomplete-intent checks, and direct shell, Python, and workflow gates still apply.

## Coverage limits

- Host hooks gate tool calls. Broad execution and restricted subagents are dispatch-only.
- Nested effects, utility commands, and trusted extensions are not contained.
- Local path checks cover a narrow literal-path grammar, not all prose, filesystem races, or unseen LSP effects.

See [Architecture](docs/architecture.md) for scope, authorization, fallback, and maintenance guarantees and [OMP integration](docs/findings/omp-integration.md) for host boundaries.

## Project documentation

[Development](docs/development.md) · [Roadmap](docs/roadmap.md) · [Design decisions](docs/decisions.md)
