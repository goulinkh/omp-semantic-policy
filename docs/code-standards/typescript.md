# TypeScript Standards

## Compiler baseline

Use strict TypeScript. Enable at least:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true
  }
}
```

Do not weaken compiler options to accommodate one implementation. Fix the model or validate the boundary.

## Model states explicitly

Use discriminated unions for actions, decisions, capability levels, provider outcomes, and onboarding states. Make invalid transitions unrepresentable where practical.

```ts
export type PolicyDecision =
  | { effect: "allow"; evidence: DecisionEvidence }
  | { effect: "prompt"; reason: string; evidence: DecisionEvidence }
  | { effect: "deny"; reason: string; evidence: DecisionEvidence }
  | { effect: "revise"; input: unknown; reason: string; evidence: DecisionEvidence };
```

Exhaustively handle unions. An assertion for an impossible variant must fail at runtime; do not use a type cast to hide it.

Use distinct types or validated constructors for values with security meaning: canonical project roots, snapshot digests, session identifiers, redacted text, and normalized targets. Do not pass ambiguous strings through the engine.

## Validate every external boundary

Treat these inputs as `unknown` until validated:

- OMP event payloads and tool inputs;
- TypeSafe responses;
- environment variables and stored JSON;
- SQLite rows and migration metadata;
- user command arguments;
- instruction files and provider-produced structured output.

Static SDK types do not replace runtime validation. Return a typed boundary error containing safe context; never continue with a partially parsed action or decision.

Defensive fallback values are appropriate only when they preserve the documented contract. Missing security-relevant data must not silently become an empty string, default project, permissive decision, or global scope.

## Keep computation pure

Compilation, precedence, deterministic evaluation, thresholding, and decision composition should be pure functions over explicit inputs. Inject time, IDs, hashing, storage, network, and filesystem access.

A function should either compute a value or coordinate effects. Do not mix project discovery, provider calls, persistence, UI, and enforcement in one function.

Do not mutate actions, source records, snapshots, or decisions after construction. Prefer readonly structures and return new values for transitions.

## Error semantics

Expected policy outcomes use result values, not exceptions:

- deny is not an error;
- prompt is not an error;
- unsupported coverage is not an error;
- provider unavailable is a typed evaluation outcome.

Throw only for broken invariants or infrastructure failures that the current layer cannot represent. Preserve the original cause when wrapping errors. Convert errors into redacted operator messages at the OMP adapter boundary.

Never catch and silently allow. An unavailable semantic decision follows the configured automatic confirmation default (`deny` unless explicitly configured otherwise); this is a recorded fallback, not a violation judgment. Default threshold `1` disables dialogs. Interactive prompting is opt-in through a threshold below `1`, and headless prompts deny. Explicit policy denials must not be weakened by the automatic confirmation default.

## Async and lifecycle

Every network call and potentially long operation must accept an `AbortSignal` and have a bounded timeout. Propagate OMP cancellation to provider evaluation, onboarding, and compilation.

Avoid unbounded concurrency. Preserve action order when policy state can change, especially around source mutation and snapshot recompilation.

Dispose database handles, event registrations, and transient UI on teardown. Do not rely on process exit for correctness.

## Security and privacy

Redact before serialization or network transmission, not after logging. Centralize redaction and test it independently.

Never log or persist:

- TypeSafe credentials or authorization headers;
- raw environment values;
- arbitrary repository source;
- unredacted instructions after consent boundaries require redaction;
- full tool inputs when a target and digest are sufficient.

Audit records contain normalized targets, decision evidence, content digests, model/compiler versions, and redacted summaries. They must not become a second session transcript.

Use parameterized SQL exclusively. Normalize and verify filesystem targets against the canonical project root before reading or writing.

## Naming and files

Name functions with precise verbs: `normalizeToolCall`, `compilePolicySnapshot`, `evaluateAction`, `applyOmpDecision`. Avoid vague names such as `process`, `handleData`, or `doPolicy` unless the operation is genuinely a protocol handler.

Keep a single-use type, constant, or helper beside its use. Extract it when multiple modules share the same invariant. A file may contain several cohesive exports; do not split code solely to satisfy a file-count convention.

Use named exports. The only expected default export is the OMP plugin entry point if the loader requires it.

## Documentation

Document exported contracts, security invariants, counterintuitive OMP behavior, and reasons for degraded coverage. Comments explain why a constraint exists, not what the next line does.

TSDoc must be self-contained. External OMP source links or issue references are supplementary evidence, not substitutes for the contract.

Do not add file-level documentation to a single-purpose module when the exported symbol already explains it. Use file-level documentation only to explain the cohesion or architectural role of a multi-export module.

## Performance

Do not repeatedly parse unchanged instruction sources, recompute snapshot digests, or invoke the policy model when a deterministic decision is sufficient. Cache by immutable content digest and version tuple.

Avoid copying full prompts, instruction corpora, or tool payloads through every layer. Pass normalized structures and redacted summaries. Do not optimize ordinary control flow before measurement; do avoid known unbounded work on every tool call.

## Dependencies

Add a runtime dependency only when it owns difficult, security-sensitive behavior better than a small local implementation. Prefer OMP and runtime primitives already present in the host.

Pin model identifiers and use lockfile-resolved package versions. Do not import private OMP source modules; integrations must use exported extension APIs or explicitly version-gated capabilities.
