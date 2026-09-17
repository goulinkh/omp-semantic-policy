# Testing Standards

## Test observable policy behavior

A permanent test must protect a behavior that could plausibly regress. Test decisions, boundaries, precedence, transitions, isolation, redaction, and real failure modes. Do not test that a mock was called, that a field was copied, or that source text contains an implementation detail.

Coverage reports identify untested risk; they are not a target. Do not add tautological cases or exclude runtime files to improve a percentage.

## Test layers

### Unit tests

Colocate focused tests with the pure module they exercise using `.test.ts`:

```text
src/policy/evaluation/evaluateAction.ts
src/policy/evaluation/evaluateAction.test.ts
```

Unit tests should cover deterministic policy behavior without OMP, SQLite, filesystem, or network dependencies.

### Integration tests

Place cross-domain tests in `src/testing/integration/`. Use real policy compiler and evaluator implementations with temporary storage and controlled provider/host boundaries.

Required integration capabilities include:

- instruction discovery to snapshot compilation;
- standing policy plus current-turn authorization;
- deterministic denial taking precedence over model output;
- policy-source mutation followed by mandatory recompilation;
- decision persistence without credential or source leakage;
- OMP event normalization followed by the correct block, prompt, allow, or revision response.

### Regression tests

A bug fix must first reproduce the observed failure when practical. Keep the reproducer when it protects a durable contract. Cross-cutting regressions live in `src/testing/regression/` with descriptive names such as `parent-instructions-cross-git-root.test.ts`.

Do not preserve a brittle wording assertion or implementation-specific spy as a regression test.

### Runtime verification

Host integration is not proven by unit tests. Before completing a behavior change, exercise it in the actual supported OMP runtime.

The runtime matrix must eventually verify:

- a built-in tool is blocked before its side effect;
- revised tool input is what executes;
- `tool_result` records the real outcome;
- an unrestricted subagent loads the gate and blocks an action;
- a restricted subagent is reported as dispatch-gated, never enforced;
- `user_bash`, `user_python`, and slash-command input can be blocked;
- broad `bash` or `eval` behavior is labeled dispatch-gated;
- unsupported OMP capabilities degrade visibly;
- teardown removes registrations and transient UI.

Store manual and exploratory probes under `experiments/`. They support investigation but are not substitutes for automated contracts.

## High-value policy cases

At minimum, preserve tests for:

- canonical Git-root isolation, nested repositories, worktrees, and symlinks;
- subtree-scoped instruction sources;
- conflicting and ambiguous instruction classification;
- hard, workflow, and advisory rule behavior;
- current-turn authorization that cannot override protected global policy;
- immutable snapshot version tuples and digest changes;
- unknown tool handling in interactive and headless sessions;
- provider timeout, malformed response, cancellation, and unavailable states;
- redaction before provider transmission and audit persistence;
- no paid inference during credential validation;
- no policy database or credentials written into a repository.

## Boundary fakes and mocks

Prefer real internal modules. Mock or fake only genuine boundaries:

- OMP event registration and UI APIs;
- TypeSafe HTTP/SDK transport;
- clocks and random identifiers;
- filesystem behavior that is destructive or OS-specific;
- process execution;
- profile paths and credential storage.

Use an in-memory or temporary real SQLite database for storage tests. Do not mock SQL calls and then assert the mock received the same fields.

Provider fixtures must be validated through the same parser used in production. Never call a live model or use a real API key in the default test suite or CI.

## Determinism and isolation

Tests must not depend on the developer's OMP profile, home directory, repository instructions, network, current time, locale, or execution order. Every test receives explicit temporary roots, profile paths, clocks, and provider outcomes.

Restore environment variables and registrations after each test. Run storage tests against unique temporary databases. No test may mutate `~/.omp`, the checkout's Git configuration, or a real repository outside its temporary fixture.

Model-backed expected results must use recorded, redacted fixtures or a deterministic fake. Do not pin prose rationale word-for-word; assert the structured decision, matched rule identifiers, and coverage class.

## Naming and structure

Use `describe` for the public capability and `it` for an observable scenario. Keep nesting shallow.

```ts
describe("evaluateAction", () => {
  it("keeps a deterministic denial when the model allows", async () => {
    // ...
  });
});
```

Place shared typed fixtures and factories under root `testing/`. Keep small one-use fixtures in the test file. Avoid large inline fixtures and untyped JSON when a typed builder makes the relevant facts clearer.

## Verification before commit

Run the narrowest affected tests during development. Before committing implementation changes, run:

1. formatter/checker;
2. TypeScript typecheck;
3. full deterministic unit and integration suite;
4. package build;
5. the specific OMP runtime scenario for changed adapter behavior.

If a runtime scenario cannot run in CI, document the exact manual command and observed result in the pull request or commit body. Never claim a coverage class that was not exercised.
