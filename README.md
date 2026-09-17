<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/policy-flow/policy-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/policy-flow/policy-mark-light.svg">
    <img src="docs/assets/policy-flow/policy-mark-light.svg" alt="" width="32" align="absmiddle">
  </picture>
  OMP Semantic Policy
</h1>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/policy-flow/policy-compilation-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/policy-flow/policy-compilation-light.svg">
  <img src="docs/assets/policy-flow/policy-compilation-light.svg" alt="Example: an AGENTS.md rule forbidding access-token logging becomes a hard rule in the compact TypeSafe policy payload. Heading context and source provenance are retained; fenced code is not compiled." width="1400">
</picture>

An [Oh My Pi](https://github.com/can1357/oh-my-pi) plugin that checks agent actions against your project instructions and authorization.

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

Uncertainty defaults to deny. A policy gate, not a sandbox.

## Get started

Requires [Bun](https://bun.sh/) ≥1.3.14 and OMP 18.1.19. Remote evaluation requires a TypeSafe AI token and consent.

```bash
git clone https://github.com/goulinkh/omp-semantic-policy.git
cd omp-semantic-policy
bun install --frozen-lockfile
omp plugin link .
```

Restart OMP inside a Git worktree, then:

```text
/login typesafe-ai
/policy consent on
/policy status
```

Projects onboard automatically. Use `TYPESAFE_API_KEY` instead of `/login` if preferred. Without credentials or consent, local checks and configured fallback remain active.

## Commands

| Command | Purpose |
| --- | --- |
| `/policy status` | Snapshot and evaluator state. |
| `/policy coverage` | Runtime enforcement coverage. |
| `/policy onboard` | Refresh project policy. |
| `/policy review` | Compiled rules. |
| `/policy audit [1–100]` | Recent redacted decisions and evidence. |
| `/policy maintenance` | Review an uncertain maintenance proposal. |
| `/policy maintenance approve <action-id>` | Approve one exact maintenance retry. |
| `/policy maintenance revoke` | Clear maintenance approval. |
| `/policy consent on` / `off` | Enable / disable remote evaluation. |
| `/logout typesafe-ai` | Remove the stored credential. |

## Configuration

| Setting | Default | Behavior |
| --- | --- | --- |
| `showStatus` | `true` | Show policy status. |
| `showViolationFeedback` | `true` | Show non-allow decisions. |
| `confirmationDefault` | `deny` | Resolve unprompted confirmation requests; `approve` opts into fail-open. |
| `confirmationThreshold` | `1` | `1`: automatic; below `1`: prompt at or above that confidence. |
| `enabledToolCalls` | `bash,eval,python,write,edit,task,hub,browser,computer,debug` | Exact-name remote evaluation allowlist; empty selects all. |
| `disabledToolCalls` | empty | Skip remote evaluation; overrides the allowlist. |

Tool filters do not bypass local protections, incomplete-intent checks, or direct shell, Python, and workflow gates. Explicit denials stay blocked. Maintenance approval is bound to one exact retry, not blanket authorization.

## Coverage limits

- Host hooks gate tool calls; broad execution and restricted subagents are dispatch-only.
- Nested effects, utility commands, and trusted extensions are not contained.
- Local path checks cover a narrow literal-path grammar, not all prose, filesystem races, or unseen LSP effects.

See [Architecture](docs/architecture.md) for scope, authorization, fallback, and maintenance guarantees; [OMP integration](docs/findings/omp-integration.md) for host boundaries.

## Development

```bash
bun run check
```

Checks formatting, lint, types, tests, and build. For a single development session: `omp -e ./src/index.ts`.

[Live tuning](docs/tuning.md) uses paid TypeSafe evaluation and is separate from default checks.

[Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md) · [Decisions](docs/decisions.md)

<sub>[Diagram renderer](docs/assets/policy-flow/render.ts) · Regenerate with `bun docs/assets/policy-flow/render.ts`.</sub>
