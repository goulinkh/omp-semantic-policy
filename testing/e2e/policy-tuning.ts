import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPolicyRepository,
  normalizeOmpToolCall,
  registerOmpPolicyRuntime,
  type PolicyRepository,
} from "../../src/adapters/omp/index.js";
import { DEFAULT_ENABLED_TOOL_CALLS } from "../../src/adapters/omp/runtime/policyPresentation.js";
import {
  createRedactedProviderState,
  createTypeSafePolicyModel,
  DEFAULT_TYPESAFE_POLICY_MODEL,
  redactText,
  TYPESAFE_QUESTION_VERSION,
  TYPESAFE_THRESHOLD_VERSION,
} from "../../src/adapters/typesafe/index.js";
import type { RedactedProviderState } from "../../src/adapters/typesafe/redactProviderState.js";
import {
  POLICY_COMPILER_VERSION,
  type PolicyAuditRecord,
  type PolicyModel,
  type PolicyModelResult,
  type PolicySnapshot,
} from "../../src/policy/index.js";

const DEFAULT_CASES = fileURLToPath(new URL("./policy-tuning-cases.json", import.meta.url));
const REGRESSION_CASES = fileURLToPath(new URL("./policy-regression-cases.json", import.meta.url));
const MAX_FIXTURE_FILES = 16;
const MAX_FIXTURE_BYTES = 128_000;
const MAX_FIXTURE_TOTAL_BYTES = 512_000;
const MAX_CORPUS_BYTES = 2_000_000;
const MAX_RULE_BYTES = 512_000;
const MAX_CASES = 100;
const MAX_REPEAT = 20;
const MAX_ATTEMPTS = 500;
const SETTINGS = {
  showStatus: false,
  showViolationFeedback: false,
  confirmationDefault: "deny" as const,
  confirmationThreshold: 1,
  enabledToolCalls: DEFAULT_ENABLED_TOOL_CALLS,
  disabledToolCalls: [],
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Effect = "allow" | "deny";
type Assessment = "assessed" | "unavailable" | "unassessed";
type ResultStatus = "match" | "mismatch" | "unavailable" | "unassessed" | "error";

interface Options {
  readonly cases: string;
  readonly output: string;
  readonly repeat: number;
  readonly rulesFrom?: string;
  readonly mode: "offline" | "live";
  readonly confirmationDefault: "approve" | "deny";
}

interface ExpectedMutation {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

interface TuningCase {
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, Json>;
  readonly request: string;
  readonly expected: Effect;
  readonly files?: Readonly<Record<string, string>>;
  readonly expectedMutations?: readonly ExpectedMutation[];
}

interface Corpus {
  readonly rules: string;
  readonly cases: readonly TuningCase[];
}

interface Exchange {
  readonly state: RedactedProviderState;
  readonly inputDigest: string;
  requestCount: number;
  latencyMs: number;
  result?: PolicyModelResult;
}

interface CaseResult {
  readonly id: string;
  readonly repetition: number;
  readonly expected: Effect;
  enforced: Effect | null;
  assessment: Assessment;
  status: ResultStatus;
  path: string;
  latencyMs: number;
  providerRequestCount: number;
  readonly execution: "suppressed";
  normalized?: RedactedProviderState;
  snapshotId?: string;
  decisionAudit?: PolicyAuditRecord;
  readonly exchanges: Exchange[];
  automaticUncertaintyApproval: boolean;
  mutationChecks: {
    readonly path: string;
    readonly status: "match" | "mismatch" | "unavailable";
  }[];
  error?: string;
}

interface SnapshotIdentity {
  readonly id: string;
  readonly versions: PolicySnapshot["versions"];
  readonly rules: PolicySnapshot["rules"];
  readonly sources: readonly {
    readonly id: string;
    readonly kind: string;
    readonly path: string;
    readonly contentDigest: string;
  }[];
}

interface Report {
  readonly schemaVersion: 2;
  readonly mode: "live-handler-dry-run" | "offline-evidence-only";
  readonly modelAccuracy: "live-assessed-results-only" | "unassessed";
  readonly execution: "suppressed";
  readonly startedAt: string;
  readonly implementationDigest: string;
  readonly dependencyDigest: string;
  readonly bunVersion: string;
  completedAt?: string;
  runStatus: "running" | "complete" | "error";
  readonly corpus: {
    readonly digest: string;
    readonly rulesDigest: string;
    readonly extraRulesDigest: string | null;
    readonly caseCount: number;
    readonly repeat: number;
  };
  readonly provider: {
    readonly id: "typesafe-ai";
    readonly requestedModel: string;
    readonly versions: PolicySnapshot["versions"];
    requestCount: number;
  };
  readonly settings: Omit<typeof SETTINGS, "confirmationDefault"> & {
    readonly confirmationDefault: "approve" | "deny";
  };
  readonly snapshots: SnapshotIdentity[];
  readonly results: CaseResult[];
  summary?: {
    readonly attempts: number;
    readonly matches: number;
    readonly mismatches: number;
    readonly falseAllows: number;
    readonly falseDenies: number;
    readonly automaticUncertaintyApprovals: number;
    readonly mutationMatches: number;
    readonly mutationMismatches: number;
    readonly mutationUnavailable: number;
    readonly unavailable: number;
    readonly unassessed: number;
    readonly errors: number;
    readonly semanticAssessed: number;
    readonly localAssessed: number;
    readonly coverageAssessed: number;
    readonly providerRequestCount: number;
  };
  error?: string;
}

class TuningError extends Error {}

function parseOptions(args: readonly string[]): Options | undefined {
  if (args.length === 1 && args[0] === "--help") return undefined;
  let mode: Options["mode"] | undefined;
  let confirmationDefault: Options["confirmationDefault"] = "deny";
  let cases = DEFAULT_CASES;
  let output = resolve("policy-tuning-results.json");
  let repeat = 1;
  let rulesFrom: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || seen.has(flag))
      throw new TuningError("Duplicate or malformed option.");
    seen.add(flag);
    if (flag === "--live" || flag === "--offline") {
      if (mode !== undefined) throw new TuningError("--live and --offline are mutually exclusive.");
      mode = flag === "--live" ? "live" : "offline";
      continue;
    }
    if (
      !["--cases", "--output", "--repeat", "--rules-from", "--confirmation-default"].includes(flag)
    ) {
      throw new TuningError("Unknown option. Use --help for the supported flags.");
    }
    const value = args[++index];
    if (
      value === undefined ||
      value.startsWith("--") ||
      value.trim().length === 0 ||
      hasControlCharacter(value)
    ) {
      throw new TuningError("Every value option requires one nonempty, control-free argument.");
    }
    if (flag === "--confirmation-default") {
      if (value !== "approve" && value !== "deny")
        throw new TuningError("--confirmation-default must be approve or deny.");
      confirmationDefault = value;
    } else if (flag === "--repeat") {
      if (!/^[1-9]\d*$/u.test(value) || Number(value) > MAX_REPEAT) {
        throw new TuningError(`--repeat must be an integer from 1 to ${MAX_REPEAT}.`);
      }
      repeat = Number(value);
    } else {
      if (value.length > 4096) throw new TuningError("A path argument exceeds 4096 characters.");
      if (flag === "--cases") cases = resolve(value);
      if (flag === "--output") output = resolve(value);
      if (flag === "--rules-from") rulesFrom = resolve(value);
    }
  }
  if (mode === undefined)
    throw new TuningError(
      "Select --offline for evidence-only checks or --live to send redacted data to TypeSafe (may incur charges).",
    );
  return {
    cases,
    output,
    repeat,
    mode,
    confirmationDefault,
    ...(rulesFrom === undefined ? {} : { rulesFrom }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TuningError("Corpus objects must contain exactly the documented fields.");
  }
}

function validateJson(value: unknown, budget: { nodes: number }, depth = 0): asserts value is Json {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > 16)
    throw new TuningError("A case input exceeds the JSON node/depth limit (10000/16).");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 64_000 && !value.includes("\u0000")) return;
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new TuningError("A case input array exceeds 1000 items.");
    for (const item of value) validateJson(item, budget, depth + 1);
    return;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 1000) throw new TuningError("A case input object exceeds 1000 fields.");
    for (const [key, item] of entries) {
      if (
        key.length === 0 ||
        key.length > 128 ||
        hasControlCharacter(key) ||
        ["__proto__", "prototype", "constructor"].includes(key)
      ) {
        throw new TuningError("A case input contains an invalid object key.");
      }
      validateJson(item, budget, depth + 1);
    }
    return;
  }
  throw new TuningError("A case input is not bounded finite JSON.");
}

function validateFixturePath(path: string): void {
  const parts = path.split("/");
  const reserved =
    /^(?:agents|claude|gemini|policy|config|settings|package|bun|npm|yarn|pnpm|tsconfig|jsconfig|omp-plugins)(?:[.-]|$)/iu;
  if (
    path.length > 240 ||
    parts.length > 8 ||
    parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(part) || reserved.test(part)) ||
    ["normal.txt", "protected.txt", "link", "plugin", "node_modules"].includes(
      parts[0]?.toLowerCase() ?? "",
    )
  ) {
    throw new TuningError(
      "Fixture paths must be bounded relative paths without traversal, hidden, policy, configuration, or protected runner components.",
    );
  }
}

function fixtureText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\u0000") &&
    Buffer.byteLength(value) <= MAX_FIXTURE_BYTES &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

function parseFixtureFiles(value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value) || Object.keys(value).length > MAX_FIXTURE_FILES)
    throw new TuningError(
      `Case files must be an object with at most ${MAX_FIXTURE_FILES} entries.`,
    );
  const entries: [string, string][] = [];
  const paths: string[] = [];
  let total = 0;
  for (const [path, content] of Object.entries(value)) {
    validateFixturePath(path);
    if (!fixtureText(content))
      throw new TuningError(
        `Fixture contents must be NUL-free UTF-8 text of at most ${MAX_FIXTURE_BYTES} bytes.`,
      );
    const folded = path.toLowerCase();
    if (
      paths.some(
        (other) =>
          other === folded || other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`),
      )
    )
      throw new TuningError(
        "Fixture file paths must not collide, including case-folded or file/directory collisions.",
      );
    paths.push(folded);
    total += Buffer.byteLength(content);
    if (total > MAX_FIXTURE_TOTAL_BYTES)
      throw new TuningError(`Case fixture contents exceed ${MAX_FIXTURE_TOTAL_BYTES} bytes.`);
    entries.push([path, content]);
  }
  return Object.fromEntries(entries);
}

function parseExpectedMutations(value: unknown): readonly ExpectedMutation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    throw new TuningError("expectedMutations must contain 1–8 file expectations.");
  const paths = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isObject(entry)) throw new TuningError("Mutation expectations must be objects.");
    requireKeys(entry, ["path", "before", "after"]);
    if (typeof entry.path !== "string")
      throw new TuningError("Mutation expectations require relative paths.");
    validateFixturePath(entry.path);
    if (
      paths.has(entry.path.toLowerCase()) ||
      !fixtureText(entry.before) ||
      !fixtureText(entry.after)
    )
      throw new TuningError(
        "Mutation expectations require unique paths and bounded UTF-8 before/after strings.",
      );
    paths.add(entry.path.toLowerCase());
    return { path: entry.path, before: entry.before, after: entry.after };
  });
}

function createCaseFixtures(projectRoot: string) {
  const files: string[] = [];
  const directories: string[] = [];
  async function containedDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    const canonical = await realpath(path);
    const within = relative(projectRoot, canonical);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (within !== "" &&
        (within === ".." ||
          within.startsWith(`..${sep}`) ||
          resolve(projectRoot, within) !== canonical))
    )
      throw new TuningError(
        "Fixture directory escaped the isolated project or contains a symlink.",
      );
  }
  return {
    async reset(contents: Readonly<Record<string, string>> = {}): Promise<void> {
      for (const path of files.splice(0).reverse()) await rm(path);
      for (const path of directories.splice(0).reverse()) await rmdir(path);
      await containedDirectory(projectRoot);
      for (const [path, content] of Object.entries(contents)) {
        validateFixturePath(path);
        let parent = projectRoot;
        for (const part of path.split("/").slice(0, -1)) {
          parent = join(parent, part);
          try {
            await mkdir(parent, { mode: 0o700 });
            directories.push(parent);
          } catch (error) {
            if (!isObject(error) || error.code !== "EEXIST") throw error;
          }
          await containedDirectory(parent);
        }
        const target = join(projectRoot, path);
        const file = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        files.push(target);
        try {
          await file.writeFile(content, "utf8");
        } finally {
          await file.close();
        }
      }
    },
  };
}

function parseCorpus(text: string): Corpus {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TuningError("The cases file must contain valid JSON.");
  }
  if (!isObject(value)) throw new TuningError("The corpus must be an object.");
  requireKeys(value, ["rules", "cases"]);
  if (
    typeof value.rules !== "string" ||
    value.rules.trim().length === 0 ||
    value.rules.includes("\u0000") ||
    Buffer.byteLength(value.rules) > MAX_RULE_BYTES
  ) {
    throw new TuningError(
      `Corpus rules must be nonempty text of at most ${MAX_RULE_BYTES} UTF-8 bytes.`,
    );
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0 || value.cases.length > MAX_CASES) {
    throw new TuningError(`The corpus must contain 1–${MAX_CASES} cases.`);
  }
  const ids = new Set<string>();
  const cases = value.cases.map((item: unknown): TuningCase => {
    if (!isObject(item)) throw new TuningError("Every corpus case must be an object.");
    const optionalKeys = ["files", "expectedMutations"].filter((key) => Object.hasOwn(item, key));
    requireKeys(item, ["id", "tool", "input", "request", "expected", ...optionalKeys]);
    if (
      typeof item.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(item.id) ||
      ids.has(item.id)
    ) {
      throw new TuningError(
        "Case IDs must be unique, 1–80 characters, and contain only letters, digits, dots, underscores, or hyphens.",
      );
    }
    ids.add(item.id);
    if (typeof item.tool !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(item.tool)) {
      throw new TuningError("Every case requires a valid tool name.");
    }
    if (
      typeof item.request !== "string" ||
      item.request.trim().length === 0 ||
      item.request.includes("\u0000") ||
      Buffer.byteLength(item.request) > 16_000
    ) {
      throw new TuningError(
        "Every case requires nonempty request text of at most 16000 UTF-8 bytes.",
      );
    }
    if (item.expected !== "allow" && item.expected !== "deny")
      throw new TuningError("Case expected must be allow or deny.");
    if (!isObject(item.input)) throw new TuningError("Case input must be a JSON object.");
    validateJson(item.input, { nodes: 10_000 });
    if (Buffer.byteLength(JSON.stringify(item.input)) > 64_000)
      throw new TuningError("A case input exceeds 64000 UTF-8 bytes.");
    const files = item.files === undefined ? undefined : parseFixtureFiles(item.files);
    const expectedMutations =
      item.expectedMutations === undefined
        ? undefined
        : parseExpectedMutations(item.expectedMutations);
    return {
      id: item.id,
      tool: item.tool,
      input: item.input,
      request: item.request,
      expected: item.expected,
      ...(files === undefined ? {} : { files }),
      ...(expectedMutations === undefined ? {} : { expectedMutations }),
    };
  });
  return { rules: value.rules, cases };
}

async function readBoundedText(path: string, limit: number): Promise<string> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile())
      throw new TuningError("Corpus and rules inputs must be regular files.");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new TuningError("An input file exceeds its byte limit.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new TuningError("Input files must be valid UTF-8.");
    }
  } finally {
    await file.close();
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateApiKey(key: string): string {
  if (key.length === 0 || key.length > 8192 || /\s/u.test(key) || hasControlCharacter(key)) {
    throw new TuningError(
      "The TypeSafe credential is empty or malformed; no credential output was retained.",
    );
  }
  return key;
}

async function resolveApiKey(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (key !== undefined && key.length > 0) return validateApiKey(key);
  // This is the sole spawned command. Never interpolate corpus input or expose token stderr.
  const token = await new Promise<string>((resolveToken, rejectToken) => {
    const child = execFile(
      "omp",
      ["token", "typesafe-ai"],
      {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 16_384,
        signal,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectToken(
            new TuningError(
              "Native OMP credential resolution failed. Log in to typesafe-ai in OMP or set TYPESAFE_API_KEY; token output was suppressed.",
            ),
          );
        } else {
          resolveToken(stdout.trim());
        }
      },
    );
    child.stdin?.end();
  });
  return validateApiKey(token);
}

type RuntimeHandler = (event: unknown, context: ExtensionContext) => unknown;
type CommandHandler = (args: string, context: ExtensionContext) => unknown;
interface Host {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  emit(event: string, payload: unknown): Promise<unknown>;
  consent(): Promise<void>;
  flushScheduled(): Promise<void>;
  dispose(): void;
}

function createHost(cwd: string, apiKey: string): Host {
  const handlers = new Map<string, RuntimeHandler>();
  const commands = new Map<string, CommandHandler>();
  const scheduled: Array<() => unknown> = [];
  const sessionId = randomUUID();
  // Deliberately omit every execution/dispatch API. This host only invokes registered gates.
  const apiBoundary = {
    registerProvider() {},
    setLabel() {},
    getAllTools() {
      return [];
    },
    registerCommand(name: string, options: unknown) {
      if (!isObject(options) || typeof options.handler !== "function")
        throw new TuningError("Invalid runtime command registration.");
      commands.set(name, options.handler as CommandHandler);
    },
    on(event: string, handler: unknown) {
      if (typeof handler !== "function" || handlers.has(event))
        throw new TuningError("Invalid runtime event registration.");
      handlers.set(event, handler as RuntimeHandler);
    },
  };
  const contextBoundary = {
    cwd,
    hasUI: false,
    mode: "rpc",
    getSystemPrompt() {
      return [];
    },
    setTimeout(callback: () => unknown) {
      scheduled.push(callback);
      return 0;
    },
    ui: {
      getEditorText() {
        return "";
      },
      setStatus() {},
      notify() {},
      async confirm() {
        return false;
      },
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
    modelRegistry: {
      async getApiKeyForProvider(provider: string) {
        if (provider !== "typesafe-ai")
          throw new TuningError("Unexpected primary-model credential lookup.");
        return apiKey;
      },
    },
  };
  // OMP exposes a broad host API; the only unchecked casts are this isolated, nonexecuting boundary.
  const context = contextBoundary as unknown as ExtensionContext;
  return {
    api: apiBoundary as unknown as ExtensionAPI,
    context,
    async emit(event, payload) {
      const handler = handlers.get(event);
      if (handler === undefined)
        throw new TuningError("A required runtime handler was not registered.");
      return await handler(payload, context);
    },
    async consent() {
      const command = commands.get("policy");
      if (command === undefined) throw new TuningError("The policy command was not registered.");
      await command("consent on", context);
    },
    async flushScheduled() {
      while (scheduled.length > 0) await scheduled.shift()?.();
    },
    dispose() {
      scheduled.length = 0;
      handlers.clear();
      commands.clear();
    },
  };
}

function checkMutations(
  expected: readonly ExpectedMutation[],
  context: unknown,
): CaseResult["mutationChecks"] {
  const files =
    isObject(context) && context.phase === "proposed" && Array.isArray(context.files)
      ? context.files
      : [];
  return expected.map((entry) => {
    const matches = files.filter((file: unknown) => isObject(file) && file.path === entry.path);
    const file: unknown = matches[0];
    if (
      matches.length !== 1 ||
      !isObject(file) ||
      file.status !== "included" ||
      !Array.isArray(file.hunks)
    )
      return { path: entry.path, status: "unavailable" };
    const before: string[] = [];
    const after: string[] = [];
    for (const hunk of file.hunks) {
      if (!isObject(hunk)) return { path: entry.path, status: "mismatch" };
      for (const side of ["before", "after"] as const) {
        const range = hunk[side];
        if (
          !isObject(range) ||
          typeof range.text !== "string" ||
          !Number.isSafeInteger(range.startLine) ||
          Number(range.startLine) < 1 ||
          !Number.isSafeInteger(range.lineCount) ||
          Number(range.lineCount) < 0
        )
          return { path: entry.path, status: "mismatch" };
        (side === "before" ? before : after).push(range.text);
      }
    }
    return {
      path: entry.path,
      status:
        before.join("") === entry.before && after.join("") === entry.after ? "match" : "mismatch",
    };
  });
}

function captureModel(
  apiKey: string,
  hasConsent: () => boolean,
  report: Report,
  current: () => CaseResult | undefined,
  cancellation: AbortSignal,
  expectations: () => readonly ExpectedMutation[] | undefined,
): PolicyModel {
  let activeExchange: Exchange | undefined;
  // The offline delegate captures the runtime's real evidence but never invents a classification.
  const model: PolicyModel =
    report.mode === "offline-evidence-only"
      ? {
          providerId: "offline-evidence-only",
          modelVersion: "offline-evidence-only",
          async validate(signal) {
            signal?.throwIfAborted();
            return { model: "offline-evidence-only", availableModels: ["offline-evidence-only"] };
          },
          async evaluate(_request, signal) {
            signal?.throwIfAborted();
            return {
              kind: "unavailable",
              reason: "Offline evidence-only run; model accuracy is unassessed.",
            };
          },
        }
      : createTypeSafePolicyModel({
          apiKey,
          hasConsent,
          timeoutMs: 30_000,
          async fetch(input, init) {
            report.provider.requestCount += 1;
            if (activeExchange !== undefined) activeExchange.requestCount += 1;
            return await fetch(input, init);
          },
        });
  return {
    providerId: model.providerId,
    modelVersion: model.modelVersion,
    validate: (signal) =>
      model.validate(signal === undefined ? cancellation : AbortSignal.any([cancellation, signal])),
    async evaluate(request, signal) {
      const result = current();
      if (result === undefined)
        throw new TuningError("Semantic evaluation occurred outside a corpus case.");
      const expected = expectations();
      if (expected !== undefined)
        result.mutationChecks = checkMutations(expected, request.action.details.mutationContext);
      const state = createRedactedProviderState(request);
      const exchange: Exchange = {
        state,
        inputDigest: digest(JSON.stringify(state)),
        requestCount: 0,
        latencyMs: 0,
      };
      result.exchanges.push(exchange);
      activeExchange = exchange;
      const started = performance.now();
      try {
        exchange.result = await model.evaluate(
          request,
          signal === undefined ? cancellation : AbortSignal.any([cancellation, signal]),
        );
        return exchange.result;
      } finally {
        exchange.latencyMs = Math.round(performance.now() - started);
        activeExchange = undefined;
      }
    },
  };
}

function summarizeSnapshot(snapshot: PolicySnapshot): SnapshotIdentity {
  return {
    id: snapshot.id,
    versions: snapshot.versions,
    rules: snapshot.rules,
    sources: snapshot.sources.map(({ id, kind, path, contentDigest }) => ({
      id,
      kind,
      path,
      contentDigest,
    })),
  };
}

function classifyAssessment(audit: PolicyAuditRecord | undefined): Assessment {
  const diagnostics = audit?.diagnostics;
  if (
    diagnostics?.path === "provider-unavailable" ||
    diagnostics?.semantic?.status === "unavailable"
  )
    return "unavailable";
  if (
    diagnostics?.path === "local-denial" ||
    diagnostics?.path === "coverage-bypass" ||
    diagnostics?.path === "no-applicable-rules"
  )
    return "assessed";
  if (diagnostics?.path === "semantic" && diagnostics.semantic?.status === "assessed")
    return "assessed";
  return "unassessed";
}

async function runCase(
  item: TuningCase,
  result: CaseResult,
  host: Host,
  repository: PolicyRepository,
  projectRoot: string,
  report: Report,
): Promise<void> {
  const started = performance.now();
  const requestCount = report.provider.requestCount;
  const actionId = randomUUID();
  const event: ToolCallEvent = {
    type: "tool_call",
    toolCallId: actionId,
    toolName: item.tool,
    input: item.input,
  };
  try {
    await host.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: item.request,
      systemPrompt: [],
    });
    const snapshot = repository.getActiveSnapshot(projectRoot);
    if (snapshot === undefined)
      throw new TuningError("Runtime onboarding did not produce a policy snapshot.");
    if (!report.snapshots.some((entry) => entry.id === snapshot.id))
      report.snapshots.push(summarizeSnapshot(snapshot));
    result.snapshotId = snapshot.id;
    result.normalized = createRedactedProviderState({
      action: normalizeOmpToolCall(event, host.context),
      snapshot,
      authorization: {
        source: "current-turn",
        explicit: false,
        scope: "request",
        summary: redactText(item.request),
      },
    });
    const response = await host.emit("tool_call", event);
    // Undefined is the real host's allow result, not a fabricated tool execution result.
    if (response === undefined) result.enforced = "allow";
    else if (isObject(response) && response.block === true) result.enforced = "deny";
    else throw new TuningError("The runtime returned an unsupported enforcement result.");
    const audit = repository
      .listAudits(projectRoot, 10)
      .find(
        (entry) =>
          entry.actionId === actionId && (entry.phase === "decision" || entry.phase === "workflow"),
      );
    if (audit !== undefined) result.decisionAudit = audit;
    const actualInput = result.exchanges.at(-1)?.state;
    if (actualInput !== undefined) result.normalized = actualInput;
    result.path = audit?.diagnostics?.path ?? "missing-audit";
    result.automaticUncertaintyApproval =
      audit?.diagnostics?.confirmation.resolution === "automatic-approve";
    result.assessment =
      report.mode === "offline-evidence-only" ? "unassessed" : classifyAssessment(audit);
    if (result.assessment !== "assessed") result.status = result.assessment;
    else if (audit?.effect !== result.enforced)
      throw new TuningError("Runtime enforcement disagreed with its persisted audit.");
    else result.status = result.enforced === item.expected ? "match" : "mismatch";
  } catch (error) {
    result.status = "error";
    result.assessment = "unassessed";
    result.error = safeError(error);
  } finally {
    result.latencyMs = Math.round(performance.now() - started);
    result.providerRequestCount = report.provider.requestCount - requestCount;
  }
  // Never emit tool_result: allowed proposals are suppressed, not reported as successful.
}

function safeError(error: unknown): string {
  return error instanceof TuningError
    ? error.message
    : "Runner infrastructure failed; raw error details were suppressed.";
}

function redactEvidence(
  value: unknown,
  apiKey: string,
  fixture: string,
  projectRoot: string,
  canonicalStates: WeakSet<object>,
  preserveSyntax = false,
): unknown {
  const canonical = preserveSyntax || (isObject(value) && canonicalStates.has(value));
  function text(input: string): string {
    let result = input;
    if (apiKey.length > 0) {
      result = result
        .replaceAll(apiKey, "[REDACTED:CREDENTIAL]")
        .replaceAll(encodeURIComponent(apiKey), "[REDACTED:CREDENTIAL]");
    }
    if (projectRoot.length > 0) result = result.replaceAll(projectRoot, "<temporary-project>");
    if (fixture.length > 0) result = result.replaceAll(fixture, "<temporary-fixture>");
    return canonical ? result : redactText(result);
  }
  if (typeof value === "string") return text(value);
  if (Array.isArray(value))
    return value.map((item: unknown) =>
      redactEvidence(item, apiKey, fixture, projectRoot, canonicalStates, canonical),
    );
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        text(key),
        redactEvidence(item, apiKey, fixture, projectRoot, canonicalStates, canonical),
      ]),
    );
  }
  return value;
}

async function saveReport(
  path: string,
  report: Report,
  apiKey: string,
  fixture: string,
  projectRoot: string,
): Promise<void> {
  // Only these factory-produced states are already credential-redacted.
  // Reapplying prose redaction would reinterpret shell argument boundaries.
  const canonicalStates = new WeakSet<object>();
  for (const result of report.results) {
    if (result.normalized !== undefined) canonicalStates.add(result.normalized);
    for (const exchange of result.exchanges) canonicalStates.add(exchange.state);
  }
  const temporary = join(dirname(path), `.policy-tuning-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify(redactEvidence(report, apiKey, fixture, projectRoot, canonicalStates), null, 2)}\n`,
        "utf8",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function summarizeReport(report: Report): void {
  const count = (status: ResultStatus) =>
    report.results.filter((result) => result.status === status).length;
  report.summary = {
    attempts: report.results.length,
    matches: count("match"),
    mismatches: count("mismatch"),
    falseAllows: report.results.filter(
      (result) => result.status === "mismatch" && result.enforced === "allow",
    ).length,
    falseDenies: report.results.filter(
      (result) => result.status === "mismatch" && result.enforced === "deny",
    ).length,
    automaticUncertaintyApprovals: report.results.filter(
      (result) => result.automaticUncertaintyApproval,
    ).length,
    mutationMatches: report.results.reduce(
      (sum, result) =>
        sum + result.mutationChecks.filter((check) => check.status === "match").length,
      0,
    ),
    mutationMismatches: report.results.reduce(
      (sum, result) =>
        sum + result.mutationChecks.filter((check) => check.status === "mismatch").length,
      0,
    ),
    mutationUnavailable: report.results.reduce(
      (sum, result) =>
        sum + result.mutationChecks.filter((check) => check.status === "unavailable").length,
      0,
    ),
    unavailable: count("unavailable"),
    unassessed: count("unassessed"),
    errors: count("error"),
    semanticAssessed: report.results.filter(
      (result) => result.assessment === "assessed" && result.path === "semantic",
    ).length,
    localAssessed: report.results.filter(
      (result) => result.assessment === "assessed" && result.path === "local-denial",
    ).length,
    coverageAssessed: report.results.filter(
      (result) =>
        result.assessment === "assessed" &&
        ["coverage-bypass", "no-applicable-rules"].includes(result.path),
    ).length,
    providerRequestCount: report.provider.requestCount,
  };
}

async function implementationDigest(): Promise<string> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const paths = ["package.json", "testing/e2e/policy-tuning.ts"];
  for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })) {
    if (!path.endsWith(".test.ts")) paths.push(path);
  }
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash
      .update(path)
      .update("\0")
      .update(await Bun.file(join(root, path)).bytes())
      .update("\0");
  }
  return hash.digest("hex");
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options === undefined) {
    console.log(
      "Usage: bun run tune:policy (--offline | --live) [--cases JSON] [--output JSON] [--repeat 1–20] [--rules-from TEXT] [--confirmation-default approve|deny]\nDefault output: ./policy-tuning-results.json. Default confirmation: deny. At most 100 cases and 500 total attempts.\n--offline: evidence-only production-runtime checks; no credentials or network. Model accuracy is unassessed, not scored.\n--live: authorized TypeSafe scoring; redacted policy/action data is sent and may incur charges. Credentials: TYPESAFE_API_KEY, otherwise private omp token typesafe-ai.\nBoth modes suppress proposed tool execution. Optional case fields: files (relative-path -> original UTF-8 contents), expectedMutations ([{path,before,after}]; exact concatenated emitted hunk text). Files reset before every attempt; protected/configuration/hidden paths are rejected. Fixtures: at most 16 files, 128000 bytes/file, 512000 bytes/case.",
    );
    return 0;
  }
  const corpus = parseCorpus(await readBoundedText(options.cases, MAX_CORPUS_BYTES));
  if (corpus.cases.length * options.repeat > MAX_ATTEMPTS)
    throw new TuningError(`At most ${MAX_ATTEMPTS} total case attempts are allowed.`);
  const extraRules =
    options.rulesFrom === undefined ? "" : await readBoundedText(options.rulesFrom, MAX_RULE_BYTES);
  if (
    options.rulesFrom !== undefined &&
    (extraRules.trim().length === 0 || extraRules.includes("\u0000"))
  ) {
    throw new TuningError("The extra rules file must contain nonempty, NUL-free text.");
  }
  const rules = `${corpus.rules.trim()}\n${extraRules.length === 0 ? "" : `\n${extraRules.trim()}\n`}`;
  if (Buffer.byteLength(rules) > MAX_RULE_BYTES)
    throw new TuningError(`Combined rules exceed ${MAX_RULE_BYTES} UTF-8 bytes.`);
  await mkdir(dirname(options.output), { recursive: true });
  const output = join(await realpath(dirname(options.output)), basename(options.output));
  const outputIdentity = await realpath(output).catch((error: unknown) => {
    if (isObject(error) && error.code === "ENOENT") return output;
    throw error;
  });
  const protectedPaths = [
    options.cases,
    DEFAULT_CASES,
    REGRESSION_CASES,
    fileURLToPath(import.meta.url),
    ...(options.rulesFrom === undefined ? [] : [options.rulesFrom]),
  ];
  if ((await Promise.all(protectedPaths.map((path) => realpath(path)))).includes(outputIdentity)) {
    throw new TuningError("Evidence output must not overwrite the runner or input files.");
  }
  const report: Report = {
    schemaVersion: 2,
    mode: options.mode === "offline" ? "offline-evidence-only" : "live-handler-dry-run",
    modelAccuracy: options.mode === "offline" ? "unassessed" : "live-assessed-results-only",
    execution: "suppressed",
    startedAt: new Date().toISOString(),
    implementationDigest: await implementationDigest(),
    dependencyDigest: createHash("sha256")
      .update(await Bun.file(new URL("../../bun.lock", import.meta.url)).bytes())
      .digest("hex"),
    bunVersion: Bun.version,
    runStatus: "running",
    corpus: {
      digest: digest(JSON.stringify({ rules, cases: corpus.cases })),
      rulesDigest: digest(rules),
      extraRulesDigest: extraRules.length === 0 ? null : digest(extraRules),
      caseCount: corpus.cases.length,
      repeat: options.repeat,
    },
    provider: {
      id: "typesafe-ai",
      requestedModel: DEFAULT_TYPESAFE_POLICY_MODEL,
      versions: {
        compiler: POLICY_COMPILER_VERSION,
        question: TYPESAFE_QUESTION_VERSION,
        thresholds: TYPESAFE_THRESHOLD_VERSION,
        model: DEFAULT_TYPESAFE_POLICY_MODEL,
      },
      requestCount: 0,
    },
    settings: { ...SETTINGS, confirmationDefault: options.confirmationDefault },
    snapshots: [],
    results: [],
  };
  let apiKey = "";
  let fixture = "";
  let projectRoot = "";
  let host: Host | undefined;
  let repository: PolicyRepository | undefined;
  let current: CaseResult | undefined;
  let currentExpectations: readonly ExpectedMutation[] | undefined;
  const cancellation = new AbortController();
  const interrupt = () =>
    cancellation.abort(new TuningError("Tuning was interrupted; completed evidence was retained."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await saveReport(output, report, apiKey, fixture, projectRoot);
    if (options.mode === "live") apiKey = await resolveApiKey(cancellation.signal);
    fixture = await mkdtemp(join(tmpdir(), "omp-policy-tuning-"));
    fixture = await realpath(fixture);
    projectRoot = join(fixture, "project");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await mkdir(join(projectRoot, "plugin"));
    const fixtureFiles = await Promise.allSettled([
      writeFile(join(projectRoot, "AGENTS.md"), rules, { mode: 0o600 }),
      writeFile(join(projectRoot, "normal.txt"), "Ordinary synthetic fixture note.\n"),
      writeFile(
        join(projectRoot, "protected.txt"),
        "Protected synthetic fixture note; no real credentials.\n",
      ),
      writeFile(join(projectRoot, "plugin", "omp-plugins.lock.json"), "{}\n"),
      writeFile(
        join(projectRoot, "package.json"),
        '{"name":"policy-tuning-fixture","private":true}\n',
      ),
      symlink("protected.txt", join(projectRoot, "link")),
    ]);
    if (fixtureFiles.some((result) => result.status === "rejected")) {
      throw new TuningError("Unable to create the isolated project fixtures.");
    }
    projectRoot = await realpath(projectRoot);
    const databasePath = join(fixture, "profile", "policy.db");
    // This sentinel only opens the injected local capture seam; no offline credential is retrieved.
    host = createHost(projectRoot, options.mode === "offline" ? "offline-evidence-only" : apiKey);
    const caseFixtures = createCaseFixtures(projectRoot);
    registerOmpPolicyRuntime(host.api, {
      databasePath,
      profileInstructionPaths: [],
      runtimeSettings: report.settings,
      standardsCompletion: async () => undefined,
      createPolicyModel: (key, hasConsent) =>
        captureModel(
          key,
          hasConsent,
          report,
          () => current,
          cancellation.signal,
          () => currentExpectations,
        ),
    });
    await host.consent();
    await host.emit("session_start", { type: "session_start" });
    await host.flushScheduled();
    repository = await createPolicyRepository(databasePath);
    for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
      if (repetition > 1) {
        await host.emit("session_switch", { type: "session_switch" });
        await host.flushScheduled();
      }
      for (const item of corpus.cases) {
        cancellation.signal.throwIfAborted();
        await caseFixtures.reset(item.files);
        currentExpectations = item.expectedMutations;
        current = {
          id: item.id,
          repetition,
          expected: item.expected,
          enforced: null,
          assessment: "unassessed",
          status: "unassessed",
          path: "not-evaluated",
          latencyMs: 0,
          providerRequestCount: 0,
          execution: "suppressed",
          exchanges: [],
          automaticUncertaintyApproval: false,
          mutationChecks: (item.expectedMutations ?? []).map(({ path }) => ({
            path,
            status: "unavailable",
          })),
        };
        report.results.push(current);
        await runCase(item, current, host, repository, projectRoot, report);
        current = undefined;
        currentExpectations = undefined;
        summarizeReport(report);
        await saveReport(output, report, apiKey, fixture, projectRoot);
        cancellation.signal.throwIfAborted();
      }
    }
    await caseFixtures.reset();
    if (report.implementationDigest !== (await implementationDigest())) {
      throw new TuningError(
        "Implementation changed during the run; preserve this report but do not promote it.",
      );
    }
    report.runStatus = "complete";
  } catch (error) {
    report.runStatus = "error";
    report.error = safeError(error);
  } finally {
    current = undefined;
    try {
      if (host !== undefined) await host.emit("session_shutdown", { type: "session_shutdown" });
    } catch {
      report.runStatus = "error";
      report.error = "Runtime shutdown failed; no raw error details were retained.";
    }
    host?.dispose();
    try {
      repository?.close();
    } catch {
      report.runStatus = "error";
      report.error = "Audit database shutdown failed; no raw error details were retained.";
    }
    try {
      if (fixture.length > 0) await rm(fixture, { recursive: true, force: true });
    } catch {
      report.runStatus = "error";
      report.error = "Temporary project removal failed; no raw error details were retained.";
    }
    report.completedAt = new Date().toISOString();
    summarizeReport(report);
    try {
      await saveReport(output, report, apiKey, fixture, projectRoot);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
  const summary = report.summary;
  if (summary === undefined) throw new TuningError("Missing tuning summary.");
  console.log(
    `${report.mode}: ${summary.attempts} attempts, ${summary.matches} matches, ${summary.falseAllows} false allows, ${summary.falseDenies} false denies, ${summary.unavailable} unavailable, ${summary.unassessed} unassessed, ${summary.errors} errors; ${summary.automaticUncertaintyApprovals} automatic uncertainty approvals; mutation evidence: ${summary.mutationMatches} matches, ${summary.mutationMismatches} mismatches, ${summary.mutationUnavailable} unavailable; ${summary.providerRequestCount} TypeSafe requests. Model accuracy: ${report.modelAccuracy}. Tool execution suppressed.`,
  );
  if (report.runStatus === "error") console.error(report.error);
  const evidencePassed = summary.mutationMismatches === 0 && summary.mutationUnavailable === 0;
  const classificationsPassed =
    options.mode === "offline" || summary.matches === corpus.cases.length * options.repeat;
  return report.runStatus === "complete" &&
    summary.errors === 0 &&
    evidencePassed &&
    classificationsPassed
    ? 0
    : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
