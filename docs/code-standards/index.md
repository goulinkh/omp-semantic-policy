# Code Standards

Project-specific standards for implementing OMP Semantic Policy.

These rules adapt the useful parts of the Mobot webapp standards to a TypeScript OMP marketplace plugin with a reusable policy engine. They are normative for implementation work.

## Standards

- [Code separation](separation.md) — dependency direction, package boundaries, OMP event handling, storage, and public APIs.
- [TypeScript](typescript.md) — correctness, modeling, external boundaries, side effects, errors, documentation, and security.
- [Testing](testing.md) — unit, integration, regression, OMP runtime, and provider contract verification.
- [Git](git.md) — atomic changes, conventional commits, scopes, verification, and repository hygiene.

## Rules intentionally not carried forward

The source standards cover a mature Svelte web application and monorepo. The following rules do not fit this repository and are intentionally omitted:

- CSS, styling, Svelte, UI-block, and no-JavaScript conventions; this project has no web UI.
- Monorepo package-layout rules; the first implementation is one package.
- Universal domain barrels, `constants.ts`, and `types.ts` files; create a boundary only when it owns a real API or multiple consumers.
- A blanket one-export-per-file rule; cohesive types and small related functions may share a module.
- Mandatory default exports; use named exports except where the OMP plugin loader requires a default entry point.
- A blanket `.at()` rule; enable `noUncheckedIndexedAccess` and use the clearest safe access pattern.
- Mandatory impurity annotations on every I/O function; side effects are already constrained to named adapter, provider, and storage modules.
- A 100% coverage threshold; coverage is diagnostic, while tests are required for risky observable behavior rather than padding a metric.
- Numbered regression filenames; descriptive regression names are sufficient until issue volume justifies a registry.
- Branch naming, protected-branch, PR-template, and release-tag policy; add these when the repository has active collaborators or releases.

## Priority

When rules conflict, use this order:

1. Prevent unintended side effects or policy bypass.
2. Preserve project isolation, credentials, and redaction.
3. Keep policy decisions deterministic and explainable.
4. Maintain the separation between reusable policy code and OMP integration.
5. Prefer the simplest implementation that satisfies the contract.
