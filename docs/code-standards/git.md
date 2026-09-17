# Git and Commit Standards

## Atomic, complete commits

Each commit contains one coherent change that builds and passes its relevant verification. Include the tests and documentation required by that behavior in the same commit.

Separate mechanical refactoring from behavior changes when doing so makes review or rollback safer. Do not split a required migration, caller update, or regression test into a later commit that leaves the earlier commit broken.

Do not commit temporary probes, debug logging, generated coverage, local databases, credentials, provider transcripts, or unredacted policy inputs.

## Conventional commit format

Use:

```text
type(scope): imperative description
```

Keep the subject at 72 characters or fewer. Complete the sentence “this commit will …”. Add a body for non-trivial decisions, compatibility constraints, policy semantics, or verification evidence.

Allowed types:

- `feat` — new user-visible behavior or supported capability;
- `fix` — correction of observable behavior;
- `refactor` — structure change without behavior change;
- `test` — test-only change;
- `docs` — documentation-only change;
- `perf` — measured performance improvement;
- `build` — package/build configuration;
- `ci` — continuous-integration configuration;
- `chore` — repository maintenance that fits no type above;
- `revert` — explicit reversal of an earlier commit.

Preferred scopes:

- `policy` — reusable compiler/evaluator contracts;
- `omp` — OMP event adapter and plugin lifecycle;
- `typesafe` — TypeSafe provider integration;
- `storage` — AuthStorage or policy database;
- `onboarding` — project setup and discovery;
- `coverage` — capability detection and reporting;
- `redaction` — privacy and egress controls;
- `docs`, `ci`, or `deps` — repository-wide maintenance.

Omit the scope when a change genuinely spans the whole repository. Do not use filenames or vague scopes such as `app`, `misc`, or `stuff`.

Examples:

```text
feat(omp): gate registered tool calls before execution
fix(policy): preserve hard denial over model approval
feat(onboarding): stop instruction discovery at Git root
test(coverage): prove restricted agents are dispatch-gated
docs: record PolicyGate upstream contract
chore(deps): update TypeSafe SDK
```

## Commit body for enforcement changes

A non-trivial enforcement commit should explain:

- the policy or host behavior changed;
- the interception boundary used;
- the resulting coverage class;
- compatibility or fallback behavior;
- exact verification performed.

Example:

```text
feat(omp): gate registered tool calls before execution

Normalize built-in, custom, and MCP calls through the shared policy gate.
Restricted child sessions remain dispatch-gated because OMP omits extensions.

Verification:
- bun test src/testing/integration/tool-gate.test.ts
- manual OMP write-denial scenario
```

Do not paste model-generated narratives, exhaustive file lists, or unverifiable claims into the body.

## Breaking changes

Mark a breaking public API or stored-schema change with `!` and a `BREAKING CHANGE:` footer:

```text
feat(policy)!: replace boolean verdicts with decisions

BREAKING CHANGE: evaluators now return PolicyDecision rather than boolean.
```

A policy database migration is not automatically a breaking change when it upgrades transparently. It is breaking if existing profiles cannot migrate or callers must act.

## Verification before commit

Before creating a commit:

- inspect the staged diff for secrets, unrelated changes, and generated output;
- run the formatter, typecheck, deterministic tests, and build;
- run the affected OMP runtime scenario for adapter behavior;
- update architecture or coverage documentation when the guarantee changes;
- confirm no stale compatibility alias or obsolete path remains.

The commit message must not claim tests, runtime behavior, or compatibility that was not actually verified.

## Repository hygiene

The repository `.gitignore` must exclude at least:

```gitignore
node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
*.db
*.db-shm
*.db-wal
*.log
```

Never commit API keys, authorization headers, OMP profile databases, policy databases, raw audit logs, or instruction corpora collected from local projects. If a secret enters history, revoke it before rewriting history.

Commit lockfiles for reproducible plugin builds. Commit schema migrations and redacted provider fixtures because they are source artifacts. Do not commit generated build output unless the OMP marketplace distribution contract explicitly requires it.

## Pull requests and releases

When pull requests are introduced, use conventional-commit titles and include summary, verification, coverage impact, privacy impact, and OMP compatibility. Prefer squash merging so `main` retains one complete conventional commit per change.

Use Semantic Versioning for marketplace releases. A change that weakens or reclassifies an advertised enforcement guarantee is breaking unless it fixes an overclaim without changing actual behavior; document either case prominently.
