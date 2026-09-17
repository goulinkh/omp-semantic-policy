# OMP Behavior Experiments

This record separates observed runtime behavior from source inspection. Paths and line positions may change between OMP releases; symbols and invariants are the durable evidence.

## Experiment 1: instruction discovery across a Git root

### Question

Does OMP stop instruction discovery at the nearest Git repository root?

### Fixture

A temporary directory contained:

```text
workspace/
  AGENTS.md              parent-only marker
  project/
    .git/
    AGENTS.md            project-only marker
    nested/
```

OMP was started with its working directory under `project/nested` and the effective instruction context was inspected for both unique markers.

### Observation

Both the project marker and the parent workspace marker were loaded. OMP therefore crossed the nearest Git root while discovering standalone `AGENTS.md` files.

### Consequence

OMP Semantic Policy must discover policy sources independently and stop at the canonical nearest Git root. Reusing the complete host prompt would violate project isolation.

### Reproduction guidance

Use unique, non-secret marker strings in the two instruction files, initialize `project` as a Git worktree, start the installed OMP version from `project/nested`, and ask it to enumerate its loaded instruction markers. Record the OMP version because this behavior may change.

## Experiment 2: registered tool wrapping

### Question

Does one extension event cover built-in and dynamically registered tools before execution?

### Method

Source inspection followed tool construction from the session registry through extension wrapping and the argument-preparation path.

### Evidence

- `session/session-tools.ts`: `#wrapRuntimeTool` applies `ExtensionToolWrapper` when the session has an extension runner.
- `session/agent-session.ts`: constructs session tools with the session's extension runner.
- `omp://extensions.md`: documents `tool_call` as a pre-execution event capable of blocking or revising input.

### Observation

Tools passing through the session registry are wrapped uniformly. The hook runs before execution and covers built-in, extension, custom, and MCP tools.

### Consequence

The initial plugin should use one generic `tool_call` adapter plus specialized argument parsers, not duplicate shadow tools for every built-in.

## Experiment 3: restricted subagent extension inheritance

### Question

Does a parent-installed extension enforce child tool calls?

### Method

Source inspection traced task execution into child-session construction for ordinary and `restrictToolNames` subagents.

### Evidence

`task/executor.ts` conditionally supplies the parent's `preloadedExtensionPaths` and `preloadedPreparedExtensions`. Restricted sessions receive empty arrays; unrestricted sessions receive the parent values. The structured-subagent path uses the same distinction.

### Observation

Unrestricted child sessions can create their own extension runners from the propagated plugin. Restricted sessions intentionally omit the plugin.

### Consequence

Unrestricted child calls can be individually enforced. Restricted children are only dispatch-gated at the parent's `task` call until OMP provides a process-wide trusted policy hook.

## Experiment 4: filesystem fallback scope

### Question

Can the process-wide file fallback serve as a universal write policy hook?

### Method

Documentation and source paths for file-write and file-delete fallback registration were inspected, including their activation conditions and covered write implementations.

### Observation

The fallback is invoked only after ordinary writes fail with permission or read-only filesystem errors such as `EPERM`, `EACCES`, or `EROFS`. Successful writes do not pass through it. Several mutation paths, including database, archive, ACP, LSP, and subprocess writes, are outside its scope.

### Consequence

Do not build policy enforcement on the fallback. It may broker a denied write, but it cannot prove that all writes were evaluated.

## Experiment 5: broad execution boundary

### Question

Can tool interception mediate effects initiated inside `bash` or `eval`?

### Method

The execution flow was traced from the registered outer tool into command/evaluation execution and host helpers.

### Observation

The complete outer input is available to `tool_call`, but nested effects do not emit independent policy events. Evaluation code can invoke browser helpers and runtime APIs; shell commands can access ambient filesystem, network, and subprocess capabilities.

### Consequence

Classify these tools as dispatch-gated. The policy may evaluate the script before launch, but it must not claim syscall, path, or network containment after launch.

## Experiment 6: direct core mutation paths

### Question

Are all OMP-originated filesystem mutations represented as tool calls?

### Method

Built-in command controllers were inspected for direct filesystem operations.

### Evidence

- `command-controller.ts` performs direct directory creation for `/move` handling.
- `todo-command-controller.ts` performs direct todo export writes.

### Observation

Some core command side effects bypass the registered tool registry. The extension `input` event can block the initiating slash command, but no individual final-write event is emitted.

### Consequence

The standalone plugin can gate interactive command dispatch. Complete internal-action coverage requires an upstream action hook.

## Experiment 7: marketplace entry point smoke test

### Question

Does OMP load the TypeScript extension entry point and expose the initial operator commands in a clean profile?

### Method

OMP 18.1.19 was launched in a PTY with an isolated `PI_CODING_AGENT_DIR`, ambient extensions disabled, and this repository's `src/index.ts` supplied through `-e`. Provider setup was skipped, leaving the session without a model or credentials. The `/policy status` and `/policy coverage` commands were then executed.

### Observation

The extension loaded without an extension error. The footer displayed `policy: conservative fallback`. `/policy status` reported the active fallback behavior, and `/policy coverage` reported registered tools as enforced, broad execution and restricted subagents as dispatch-gated, and the not-yet-implemented direct shell/Python and slash-command adapters as uncovered.

This smoke test proves extension loading, lifecycle status, and command rendering. It does not prove a real model-issued tool call reached the gate because the isolated profile intentionally had no model credentials.

### Consequence

The marketplace entry shape is compatible with OMP 18.1.19. A credentialed runtime probe remains required to prove pre-effect blocking through the complete agent loop.

## Evidence quality and next experiments

The Git-boundary result is a runtime observation. Experiments 2–6 are source-backed behavioral findings and should receive executable regression probes when implementation begins.

Required future probes:

1. Assert event order among `tool_call`, native approval, tool execution, `tool_result`, and persistence.
2. Run the marketplace plugin in an unrestricted child and prove the child gate blocks a write.
3. Run the same action in a restricted child and prove the coverage report says dispatch-only.
4. Verify `user_bash`, `user_python`, and `input` can return blocked synthetic results without side effects.
5. Exercise an allowed `eval` containing a nested browser or filesystem action and prove no nested policy event appears.
6. Verify nested repositories and symlinked worktrees produce distinct canonical project identities.
7. Verify policy-source edits force recompilation before the next high-impact action.
