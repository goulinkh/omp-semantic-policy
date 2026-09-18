# Development

Run commands from the repository root. For plugin installation and authentication, see [Get started](../README.md#get-started).

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

The check command verifies formatting, lint, TypeScript types, tests, and the build. Use `bun run format` to apply formatting changes.

## Run a local session

Build and link this checkout only for development:

```bash
bun run build
omp plugin link .
```

Restart OMP after rebuilding. For a one-off session without a persistent link, load the source directly with `omp -e ./src/index.ts`.

Do not load `src/index.ts` explicitly in a session already using the installed bundle unless testing duplicate registration. Registered-tool assessments are coalesced, but loading one entry point avoids redundant lifecycle work.

## Native marketplace regression

```bash
bun run test:e2e:marketplace
```

This opt-in test builds the distributable and uses the pinned OMP CLI to register the local marketplace, install an isolated copy, and exercise `/policy status` plus real allowed and protected writes. It runs both installed-only and installed-plus-source sessions and checks one decision/result audit pair per tool call. A local primary-model fixture drives dispatch; no live model calls or credentials are used. The temporary home, profile, and Git project are removed afterward. The normal `bun run check` suite skips this native test.

## Live tuning

[Live tuning](tuning.md) uses paid [TypeSafe AI](https://typesafe.ai/) evaluation and is separate from the default checks. Follow that guide for disposable fixtures, credential handling, and interpreting results.

## Diagram assets

Regenerate the README's light and dark SVGs:

```bash
bun docs/assets/policy-flow/render.ts
```

The [renderer](assets/policy-flow/render.ts) writes to [the policy-flow asset directory](assets/policy-flow/). The liquid-glass implementation follows [KUBE's refraction and specular-highlight study](https://kube.io/blog/liquid-glass-css-svg/).

## Project references

[Code standards](code-standards/index.md) · [Architecture](architecture.md) · [Roadmap](roadmap.md) · [Decisions](decisions.md)
