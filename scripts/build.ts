import { rm } from "node:fs/promises";
import { resolve } from "node:path";

interface SourcePackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly type: "module";
  readonly repository: {
    readonly type: string;
    readonly url: string;
  };
  readonly engines: Record<string, string>;
  readonly omp: {
    readonly settings: Record<string, unknown>;
  };
}

const repositoryRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(repositoryRoot, "src");
const outputRoot = resolve(repositoryRoot, "dist");
const sourceManifest = (await Bun.file(
  resolve(repositoryRoot, "package.json"),
).json()) as SourcePackageManifest;

await rm(outputRoot, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [resolve(sourceRoot, "index.ts"), resolve(sourceRoot, "policy/index.ts")],
  outdir: outputRoot,
  root: sourceRoot,
  naming: "[dir]/[name].[ext]",
  target: "bun",
  format: "esm",
  external: ["@oh-my-pi/*"],
});

if (!build.success) {
  for (const message of build.logs) console.error(message);
  throw new Error("Distribution build failed");
}

const distributionManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  description: sourceManifest.description,
  type: sourceManifest.type,
  repository: sourceManifest.repository,
  engines: sourceManifest.engines,
  exports: {
    ".": "./policy/index.js",
    "./omp": "./index.js",
  },
  omp: {
    extensions: ["./index.js"],
    settings: sourceManifest.omp.settings,
  },
};

await Bun.write(
  resolve(outputRoot, "package.json"),
  `${JSON.stringify(distributionManifest, null, 2)}\n`,
);
