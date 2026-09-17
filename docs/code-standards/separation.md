# Code Separation Standards

## Required source boundaries

Use one package with explicit domains:

```text
src/
  policy/                 reusable, host-independent policy engine
    actions/              normalized action types and validation
    compiler/             instruction sources to immutable snapshots
    evaluation/           deterministic and semantic decision composition
    projects/             canonical project identity and source scoping
    index.ts              exported reusable policy API
  providers/
    typesafe/             TypeSafe policy-model implementation
  adapters/
    omp/
      events/             OMP event normalization and decision application
      commands/           /policy commands
      storage/            AuthStorage and policy.db implementations
      ui/                 status, widgets, prompts, and notifications
  index.ts                plugin composition and registration only
testing/                  shared test fixtures and host fakes
experiments/              disposable/manual runtime probes, never published
```

Add folders only when implementation exists. Do not pre-create empty architecture.

## Dependency direction

Allowed dependencies:

```text
src/index.ts
  -> adapters/omp
  -> providers/typesafe
  -> policy

adapters/omp
  -> policy public API
  -> provider and storage ports
  -> OMP SDK

providers/typesafe
  -> policy model contracts
  -> TypeSafe SDK

policy
  -> standard runtime libraries only
```

Forbidden dependencies:

- `policy` importing OMP, TypeSafe, SQLite, UI, environment, or filesystem modules.
- `policy` reading global state, process environment, current directory, or wall-clock time directly.
- `providers/typesafe` importing OMP APIs or applying allow/deny decisions.
- OMP event handlers calling the TypeSafe SDK directly.
- UI or command modules implementing policy semantics.
- Storage implementations deciding policy.

Pass clocks, digests, project discovery, storage, and policy-model evaluation through narrow interfaces where the engine needs them.

## Cross-domain imports

Each top-level domain exposes a deliberate `index.ts` API. Cross-domain imports use that API. Imports inside one domain use the owning implementation module directly; they must not route back through their own barrel.

Do not add wildcard path aliases to a published package. Use relative ESM imports compatible with the selected TypeScript module mode.

Do not create `utils/`, `helpers/`, or `common/` dumping grounds. A shared function belongs to the domain that owns its invariant. If no domain owns it, the abstraction is probably premature.

## Policy engine responsibilities

The policy engine:

- normalizes and validates provider-independent actions;
- compiles instruction sources with provenance;
- evaluates deterministic constraints before semantic questions;
- combines standing policy with current-turn authorization;
- returns `allow`, `prompt`, `deny`, or `revise` as data;
- records why a decision was reached;
- never performs the proposed side effect.

Hard deterministic denials cannot be weakened by a semantic model result. Policy denial is a normal decision, not an exception.

Snapshots are immutable values. Editing a policy source is governed by the current snapshot; a successful edit marks the project stale and requires recompilation before another high-impact action.

## Policy-model provider responsibilities

A provider adapter:

- translates the general policy-model request into provider-specific input;
- validates provider responses before returning them;
- enforces timeouts and cancellation;
- reports provider unavailability distinctly from a valid deny decision;
- exposes provider and model version metadata;
- performs redaction before network transmission.

The provider does not discover files, infer OMP session authority, persist snapshots, display UI, or execute actions.

Jev-specific request and response types remain inside `providers/typesafe`. The public contract uses policy-model terminology.

## OMP adapter responsibilities

Each OMP event module performs exactly four steps:

1. Capture the host event and trusted session metadata.
2. Normalize it into a `PolicyAction`.
3. Invoke the central gate.
4. Translate the decision into the event's supported block, prompt, or revised-input result.

Do not duplicate policy rules among `tool_call`, `input`, `user_bash`, `user_python`, or `task` handling.

Registered-tool interception is the precise enforcement path. Broad execution such as `bash`, `eval`, browser-run code, and restricted subagent dispatch must be labeled dispatch-gated rather than sandboxed. File permission fallbacks must never be presented as generic enforcement.

Unknown tools and unsupported OMP versions must pass through the central capability policy; event handlers must not silently allow them.

## Entrypoint discipline

`src/index.ts` is composition only:

- construct storage, provider, compiler, and gate dependencies;
- register the TypeSafe runtime provider;
- register OMP event handlers and `/policy` commands;
- expose lifecycle teardown.

Do not place parsing, policy decisions, SQL, network calls, or UI text generation in the entrypoint.

Registration must be idempotent within one OMP process. Teardown must release resources and must not leave process-wide handlers registered.

## Storage separation

Use OMP `AuthStorage` for credentials. Never query or modify OMP `agent.db` tables directly.

Use the plugin-owned profile-scoped `policy.db` for projects, snapshots, onboarding, source digests, consent references, and audit metadata. Database migrations must be versioned, transactional, forward-only, and tested against a database created by the previous schema version.

Repositories must not receive policy databases, credentials, model responses, or private audit data. Project files are inputs, not storage locations.

## Public API

Export only the reusable policy contracts and engine operations needed by another host adapter. Do not export OMP event payloads, SQLite records, TypeSafe SDK types, internal compiler nodes, or testing helpers.

Mark an exported API experimental only when consumers may legitimately use it before stabilization, and explain what may change. Do not use `@experimental` to excuse an unfinished contract.
