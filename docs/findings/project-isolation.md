# Project Isolation Findings

## Required discovery boundary

The compiler must perform its own instruction discovery. It cannot rely on the host's assembled prompt because current OMP discovery may include instruction files above the nearest Git repository.

Algorithm:

1. Resolve the working directory through real paths.
2. Find the nearest enclosing Git worktree root.
3. Use that real root as the project identity.
4. Never traverse parent directories above that root for project instructions.
5. Discover nested instruction files only within the repository.
6. Scope a nested `AGENTS.md` to its directory subtree.
7. Treat a nested Git worktree as a new project with a separate identity and snapshot.
8. Load user-global instructions through a distinct source channel, never by continuing ancestor traversal.

## Why host prompt reuse is unsafe

A fixture with an instruction file above a nested Git repository showed that OMP loaded both the project instruction and the parent workspace instruction. This crosses the desired project boundary and could leak unrelated instructions or allow an ancestor workspace to influence repository policy.

The policy compiler must therefore preserve its own source list and provenance. Prompt text supplied by OMP may remain useful to the conversational model, but it is not authoritative input to policy compilation.

## Full prompt isolation

Compiler isolation is possible in the standalone plugin. Preventing OMP's conversational prompt from including ancestor instructions requires an OMP core discovery boundary setting or API. That distinction must remain visible:

- **Policy isolation**: achievable in the plugin now.
- **Host prompt isolation**: requires host support.

## Instruction precedence

The intended source classes are:

- profile/global policy;
- repository-root policy;
- subtree policy;
- current-turn explicit user authorization.

Current-turn authorization does not automatically override protected global constraints. The engine must preserve source provenance and identify conflicts rather than flattening all text into one prompt.

## Project state

Project state belongs in the profile-scoped policy database, keyed by canonical project identity. Expected records include:

- first-seen and last-seen timestamps;
- onboarding state;
- active snapshot digest;
- snapshot history;
- consent references;
- source digests and compile outcomes;
- coverage observations;
- model/compiler/question/threshold versions.

Session entries are unsuitable because project policy must survive session deletion and apply consistently across sessions.

## Source mutation rule

A policy source cannot retroactively authorize its own modification. The currently active snapshot decides whether the edit may occur. After an allowed edit, the project becomes policy-stale and must recompile before another high-impact write, execution, delegation, or network action.

This avoids a gap where an agent weakens a policy file and immediately acts under the weakened interpretation without an explicit compilation transition.
