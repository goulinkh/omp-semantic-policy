# Architecture

## Product boundary

OMP Semantic Policy is a semantic policy plane, not a sandbox. It decides whether a proposed OMP action is consistent with standing instructions and current user authorization. OMP remains responsible for exposing a pre-effect interception point and enforcing the returned decision.

The first delivery is one marketplace package with a strict source boundary:

```text
src/policy/          compiler, snapshots, precedence, evaluation, decisions
src/adapters/omp/    OMP events, commands, UI, storage integration
```

`src/policy` must not import OMP. It should be exported for reuse. A separate package is deferred until a second consumer justifies it.

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

Deterministic rules run first. They cover explicit prohibitions, exact path restrictions, project boundaries, protected credentials, and already-resolved user authorization. Model evaluation handles semantic matching, ambiguity, and instruction classification; it must not weaken a deterministic denial.

## Normalized action

The implemented `PolicyAction` records:

- action identifier and timestamp;
- actor plus session and optional parent-session lineage;
- working directory;
- operation class: read, write, execute, delegate, network, workflow, internal, or unknown;
- host operation, structured input, and source metadata when available;
- normalized targets;
- interception capability: precise, dispatch-only, advisory, or absent.

The evaluation context separately carries headless state and optional authorization and snapshot references. Project compilation will populate those references without coupling actions to OMP storage.

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

Decision evidence identifies the evaluator, evidence class, and matched rule identifiers. Model, compiler, question, and threshold versions will enter evidence through compiled snapshot metadata. User-facing explanations stay concise; durable audit records may be richer but must remain redacted.

## Instruction classification

Compiled instructions use three behavioral classes:

1. **Hard requirement** — explicit and unambiguous constraints may block actions.
2. **Workflow requirement** — sequencing and completion obligations are checked at relevant transitions and session stop.
3. **Advisory preference** — style or preference guidance influences behavior but does not block.

Ambiguous or conflicting requirements require review instead of silently becoming hard enforcement.

## Policy snapshot

A snapshot is immutable and includes:

- normalized instruction sources and provenance;
- compiled rules and their classifications;
- project identity and source boundaries;
- policy-model identifier and version;
- compiler version;
- question/prompt version;
- threshold version;
- consent and redaction configuration;
- creation time and content digest.

When a policy source is modified, the old snapshot governs the mutation that changes it. A new snapshot must be compiled before the next high-impact action.

## Project identity and scope

Project identity is the real path of the nearest enclosing Git worktree. Discovery must stop at that root. Nested repositories are separate projects. Nested `AGENTS.md` files are subtree-scoped; user-global instructions are a separate source class rather than an ancestor directory.

No policy data may be keyed only by the current directory string. Symlink resolution and worktree identity are required to prevent duplicate or cross-project state.

## Storage

- Credentials: OMP `AuthStorage` in the profile-scoped `agent.db`.
- Project state and snapshots: profile-scoped `~/.omp/agent/policy.db`.
- Session entries: unsuitable for durable project state.
- Policy state must not add private tables to OMP's `agent.db`.

The credential store is expected to live in a mode `0700` directory with database mode `0600`. The current representation is plaintext JSON inside SQLite; this is host-compatible storage, not an operating-system keychain.

## Provider abstraction

The policy engine must treat Jev as one implementation of a broader policy-model contract. A provider evaluates normalized policy questions and returns a decision-oriented result with confidence and rationale sufficient for thresholding and audit. Provider-specific response shapes stay behind an adapter.

The first provider integration is TypeSafe:

- provider name: `typesafe-ai`;
- OMP-native `/login typesafe-ai` and `/logout typesafe-ai`;
- validation using the models-list endpoint, not paid inference;
- `TYPESAFE_API_KEY` environment fallback;
- one-time profile consent before sending instruction text;
- redaction before egress;
- no arbitrary repository source transmission.

## Availability behavior

Local deterministic rules remain available without the remote provider. If semantic evaluation is unavailable:

- reads are allowed unless a deterministic rule protects the target;
- writes, execution, and delegation prompt in interactive sessions;
- the same actions deny when prompting is impossible;
- advisory rules never become blocking due solely to provider failure.

Unknown tools follow the same conservative behavior.

## Threat boundary

The plugin can enforce only at events the host emits before effects. It cannot provide process containment after allowing arbitrary shell or evaluation code. It also cannot defend against a malicious trusted project extension executing outside registered tool calls. Coverage must therefore be reported per surface and never described as a sandbox.
