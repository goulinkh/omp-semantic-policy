import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { InstructionSource } from "../../../policy/index.js";
import { hasGitMarker } from "../projects/index.js";

const IGNORED_DIRECTORIES: Readonly<Record<string, true>> = {
  ".git": true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
  target: true,
  vendor: true,
};

const PREVIEW_EXTENSIONS: Readonly<Record<string, true>> = {
  "": true,
  ".adoc": true,
  ".md": true,
  ".markdown": true,
  ".mdx": true,
  ".prompt": true,
  ".rst": true,
  ".rules": true,
  ".txt": true,
};

const MAX_CANDIDATES = 1_000;
const MAX_PREVIEW_BYTES = 2_000;
const MAX_PREVIEW_TOTAL = 80_000;
const MAX_RUNTIME_BLOCKS = 32;
const MAX_RUNTIME_BLOCK_LENGTH = 12_000;
const MAX_RUNTIME_TOTAL = 48_000;
const MAX_SELECTED_FILES = 64;
const MAX_SELECTED_FILE_BYTES = 512_000;
const MAX_RUNTIME_EXCERPTS = 16;
const MAX_RUNTIME_EXCERPT_LENGTH = 8_000;

export interface StandardsSourceResolutionRequest {
  readonly projectRoot: string;
  readonly existingSources: readonly InstructionSource[];
  readonly force: boolean;
}

export interface StandardsSourceResolver {
  resolve(request: StandardsSourceResolutionRequest): Promise<readonly InstructionSource[]>;
}

export type StandardsModelCompletion = (
  prompt: string,
  signal: AbortSignal,
) => Promise<string | undefined>;

export interface StandardsSourceResolverOptions {
  readonly complete: StandardsModelCompletion;
  readonly getRuntimeContext: () => readonly string[];
  readonly sanitize?: (text: string) => string;
  readonly timeoutMs?: number;
}

interface ProjectCandidate {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly preview?: string;
}

interface RuntimeContextBlock {
  readonly id: number;
  readonly content: string;
}
interface RawModelSelection {
  readonly projectPaths?: unknown;
  readonly runtimeExcerpts?: unknown;
}

interface ModelSelection {
  readonly projectPaths: readonly string[];
  readonly runtimeExcerpts: readonly {
    readonly blockId: number;
    readonly text: string;
  }[];
}

/**
 * Discover supplemental standards through the active model, then admit only
 * canonical project files and exact runtime-context excerpts into policy.
 */
export function createStandardsSourceResolver(
  options: StandardsSourceResolverOptions,
): StandardsSourceResolver {
  const cache = new Map<string, ModelSelection>();
  const unavailableUntil = new Map<string, number>();

  return {
    async resolve(request) {
      const canonicalRoot = await realpath(request.projectRoot);
      const existingPaths = new Set(request.existingSources.map((source) => resolve(source.path)));
      const sanitize = options.sanitize ?? ((text: string) => text);
      const candidates = await collectProjectCandidates(canonicalRoot, existingPaths, sanitize);
      const runtimeBlocks = collectRuntimeContext(options.getRuntimeContext(), sanitize);
      const cacheKey = digest(
        JSON.stringify({
          candidates: candidates.map(({ relativePath, preview }) => ({
            relativePath,
            ...(preview === undefined ? {} : { preview }),
          })),
          runtimeBlocks,
        }),
      );

      let selection = request.force ? undefined : cache.get(cacheKey);
      if (
        selection === undefined &&
        !request.force &&
        (unavailableUntil.get(cacheKey) ?? 0) > Date.now()
      ) {
        selection = { projectPaths: [], runtimeExcerpts: [] };
      }
      if (selection === undefined) {
        const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
        const response = await options.complete(buildScanPrompt(candidates, runtimeBlocks), signal);
        selection = validateModelSelection(
          response,
          candidates,
          runtimeBlocks,
          request.existingSources,
        );
        if (response === undefined) {
          unavailableUntil.set(cacheKey, Date.now() + 30_000);
        } else {
          cache.set(cacheKey, selection);
          unavailableUntil.delete(cacheKey);
        }
      }

      return loadSelectedSources(canonicalRoot, selection, candidates);
    },
  };
}

async function collectProjectCandidates(
  projectRoot: string,
  existingPaths: ReadonlySet<string>,
  sanitize: (text: string) => string,
): Promise<readonly ProjectCandidate[]> {
  const paths: string[] = [];
  await walkCandidatePaths(projectRoot, projectRoot, paths);
  paths.sort((left, right) => left.localeCompare(right));

  const candidates: ProjectCandidate[] = [];
  let previewBudget = MAX_PREVIEW_TOTAL;
  for (const absolutePath of paths) {
    if (
      candidates.length >= MAX_CANDIDATES ||
      existingPaths.has(resolve(absolutePath)) ||
      previewBudget <= 0
    ) {
      continue;
    }
    const relativePath = toPortablePath(relative(projectRoot, absolutePath));
    if (PREVIEW_EXTENSIONS[extname(relativePath).toLowerCase()] !== true) {
      continue;
    }
    const rawPreview = await readTextPreview(
      absolutePath,
      Math.min(MAX_PREVIEW_BYTES, previewBudget),
    );
    if (rawPreview === undefined) {
      continue;
    }
    const preview = sanitize(rawPreview);
    previewBudget -= preview.length;
    candidates.push({ absolutePath, relativePath, preview });
  }
  return candidates;
}

async function walkCandidatePaths(
  projectRoot: string,
  directory: string,
  paths: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (
        IGNORED_DIRECTORIES[entry.name] === true ||
        (entryPath !== projectRoot && (await hasGitMarker(entryPath)))
      ) {
        continue;
      }
      await walkCandidatePaths(projectRoot, entryPath, paths);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const canonicalPath = await realpath(entryPath);
    if (isPathWithin(projectRoot, canonicalPath)) {
      paths.push(canonicalPath);
    }
  }
}

async function readTextPreview(path: string, limit: number): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) {
      return undefined;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    } catch {
      return undefined;
    }
  } finally {
    await handle.close();
  }
}

function collectRuntimeContext(
  rawBlocks: readonly string[],
  sanitize: (text: string) => string,
): readonly RuntimeContextBlock[] {
  const blocks: RuntimeContextBlock[] = [];
  let remaining = MAX_RUNTIME_TOTAL;

  for (const [id, rawBlock] of rawBlocks.entries()) {
    if (blocks.length >= MAX_RUNTIME_BLOCKS || remaining <= 0) {
      break;
    }
    const content = sanitize(rawBlock)
      .slice(0, Math.min(MAX_RUNTIME_BLOCK_LENGTH, remaining))
      .trim();
    if (content.length === 0) {
      continue;
    }
    blocks.push({ id, content });
    remaining -= content.length;
  }
  return blocks;
}

function buildScanPrompt(
  candidates: readonly ProjectCandidate[],
  runtimeBlocks: readonly RuntimeContextBlock[],
): string {
  const projectInput = candidates
    .map((candidate) =>
      candidate.preview === undefined
        ? `PATH ${JSON.stringify(candidate.relativePath)}`
        : `PATH ${JSON.stringify(candidate.relativePath)}\nPREVIEW ${JSON.stringify(candidate.preview)}`,
    )
    .join("\n");
  const runtimeInput = runtimeBlocks
    .map((block) => `BLOCK ${block.id}\n${block.content}`)
    .join("\n---\n");

  return [
    "Runtime excerpts must be project-specific standards originating from active skills or MCP instructions. Do not select general assistant persona, host operation, or tool-usage instructions.",
    "Select only files whose path or preview clearly contains normative development rules, contribution requirements, agent skills, or project instructions.",
    "Do not select ordinary source code, generated output, changelogs, examples, or descriptive documentation without normative rules.",
    "Runtime context may contain active skill or MCP instructions. Return only short, exact, verbatim excerpts that state normative rules; never paraphrase or invent text.",
    "AGENTS.md and CLAUDE.md files already loaded by the host are absent from the candidates.",
    `Return exactly one JSON object with this shape: {"projectPaths":["relative/path"],"runtimeExcerpts":[{"blockId":0,"text":"exact excerpt"}]}`,
    "Use only listed paths and block IDs. Return empty arrays when no additional standards are present.",
    "",
    "PROJECT FILES",
    projectInput || "(none)",
    "",
    "RUNTIME CONTEXT",
    runtimeInput || "(none)",
  ].join("\n");
}
function validateModelSelection(
  response: string | undefined,
  candidates: readonly ProjectCandidate[],
  runtimeBlocks: readonly RuntimeContextBlock[],
  existingSources: readonly InstructionSource[],
): ModelSelection {
  if (response === undefined) {
    return { projectPaths: [], runtimeExcerpts: [] };
  }

  const parsed = parseJsonObject(response);
  if (parsed === undefined) {
    return { projectPaths: [], runtimeExcerpts: [] };
  }
  const candidatePaths = new Set(candidates.map((candidate) => candidate.relativePath));
  const blocks = new Map(runtimeBlocks.map((block) => [block.id, block.content]));
  const projectPaths: string[] = [];
  const runtimeExcerpts: Array<{ blockId: number; text: string }> = [];

  if (Array.isArray(parsed.projectPaths)) {
    for (const value of parsed.projectPaths) {
      if (
        projectPaths.length >= MAX_SELECTED_FILES ||
        typeof value !== "string" ||
        !candidatePaths.has(value) ||
        projectPaths.includes(value)
      ) {
        continue;
      }
      projectPaths.push(value);
    }
  }

  if (Array.isArray(parsed.runtimeExcerpts)) {
    for (const value of parsed.runtimeExcerpts) {
      if (
        runtimeExcerpts.length >= MAX_RUNTIME_EXCERPTS ||
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("blockId" in value) ||
        typeof value.blockId !== "number" ||
        !Number.isInteger(value.blockId) ||
        !("text" in value) ||
        typeof value.text !== "string"
      ) {
        continue;
      }
      const text = value.text.trim();
      const block = blocks.get(value.blockId);
      if (
        block === undefined ||
        text.length === 0 ||
        text.length > MAX_RUNTIME_EXCERPT_LENGTH ||
        !block.includes(text) ||
        existingSources.some((source) => source.content.includes(text)) ||
        runtimeExcerpts.some(
          (excerpt) => excerpt.blockId === value.blockId && excerpt.text === text,
        )
      ) {
        continue;
      }
      runtimeExcerpts.push({ blockId: value.blockId, text });
    }
  }

  return { projectPaths, runtimeExcerpts };
}

function parseJsonObject(text: string): RawModelSelection | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as RawModelSelection;
  } catch {
    return undefined;
  }
}

async function loadSelectedSources(
  projectRoot: string,
  selection: ModelSelection,
  candidates: readonly ProjectCandidate[],
): Promise<readonly InstructionSource[]> {
  const candidateByPath = new Map(
    candidates.map((candidate) => [candidate.relativePath, candidate]),
  );
  const sources: InstructionSource[] = [];

  for (const relativePath of selection.projectPaths) {
    const candidate = candidateByPath.get(relativePath);
    if (candidate === undefined) {
      continue;
    }
    const stats = await lstat(candidate.absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SELECTED_FILE_BYTES) {
      continue;
    }
    const canonicalPath = await realpath(candidate.absolutePath);
    if (!isPathWithin(projectRoot, canonicalPath)) {
      continue;
    }
    const content = await readUtf8File(canonicalPath);
    if (content === undefined) {
      continue;
    }
    sources.push({
      id: `model-project:${relativePath}`,
      kind: "project",
      path: canonicalPath,
      scopeRoot: projectRoot,
      content,
      contentDigest: digest(content),
      precedence: 110,
    });
  }

  if (selection.runtimeExcerpts.length > 0) {
    const content = selection.runtimeExcerpts.map((excerpt) => excerpt.text).join("\n\n");
    const contentDigest = digest(content);
    sources.push({
      id: `runtime-context:${contentDigest}`,
      kind: "project",
      path: `runtime://default-model/${contentDigest}`,
      scopeRoot: projectRoot,
      content,
      contentDigest,
      precedence: 110,
    });
  }

  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

async function readUtf8File(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_SELECTED_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SELECTED_FILE_BYTES) {
      return undefined;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      return undefined;
    }
  } finally {
    await handle.close();
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
