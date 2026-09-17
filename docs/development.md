# Development

Run commands from the repository root. For plugin installation and authentication, see [Get started](../README.md#get-started).

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

The check command verifies formatting, lint, TypeScript types, tests, and the build. Use `bun run format` to apply formatting changes.

## Run a local session

Load the local source for a single [OMP](https://github.com/can1357/oh-my-pi) session:

```bash
omp -e ./src/index.ts
```

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
