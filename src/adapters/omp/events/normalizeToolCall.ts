import type { ExtensionContext, ToolCallEvent, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import type {
  InterceptionCapability,
  PolicyAction,
  PolicyOperation,
  PolicyTarget,
  PolicyTargetKind,
} from "../../../policy/index.js";

const PRECISE_TOOL_OPERATIONS: Readonly<Record<string, PolicyOperation>> = {
  ask: "workflow",
  edit: "write",
  glob: "read",
  grep: "read",
  read: "read",
  todo: "workflow",
  write: "write",
};

const DISPATCH_TOOL_OPERATIONS: Readonly<Record<string, PolicyOperation>> = {
  bash: "execute",
  browser: "execute",
  computer: "execute",
  debug: "execute",
  eval: "execute",
  lsp: "execute",
  python: "execute",
  task: "delegate",
  web_search: "network",
};
export interface OmpToolNormalizationContext {
  readonly cwd: ExtensionContext["cwd"];
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}

export interface NormalizeOmpToolCallOptions {
  readonly now?: () => number;
  readonly toolInfo?: ToolInfo | undefined;
}

/** Convert an OMP tool event into the provider-independent policy vocabulary. */
export function normalizeOmpToolCall(
  event: ToolCallEvent,
  context: OmpToolNormalizationContext,
  options: NormalizeOmpToolCallOptions = {},
): PolicyAction {
  const input: Readonly<Record<string, unknown>> = { ...event.input };
  const operation = classifyOmpToolOperation(event.toolName);
  const targets = extractTargets(event.toolName, input);

  return {
    id: event.toolCallId,
    occurredAtMs: (options.now ?? Date.now)(),
    actor: {
      kind: "agent",
      sessionId: context.sessionManager.getSessionId(),
    },
    workingDirectory: context.cwd,
    operation,
    interception: classifyInterception(event.toolName, input, options.toolInfo),
    targets,
    hostAction: {
      host: "omp",
      name: event.toolName,
      input,
      ...(options.toolInfo === undefined
        ? {}
        : {
            source: {
              kind: options.toolInfo.sourceInfo.source,
              path: options.toolInfo.sourceInfo.path,
            },
          }),
    },
  };
}

export function classifyOmpToolOperation(toolName: string): PolicyOperation {
  return PRECISE_TOOL_OPERATIONS[toolName] ?? DISPATCH_TOOL_OPERATIONS[toolName] ?? "unknown";
}

function classifyInterception(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  toolInfo: ToolInfo | undefined,
): InterceptionCapability {
  if (DISPATCH_TOOL_OPERATIONS[toolName] !== undefined) {
    return "dispatch-only";
  }

  if (toolInfo?.sourceInfo.source === "mcp") {
    return "dispatch-only";
  }

  const path = getString(input, "path");
  if (path?.startsWith("xd://") || path?.startsWith("ssh://")) {
    return "dispatch-only";
  }

  return PRECISE_TOOL_OPERATIONS[toolName] === undefined ? "dispatch-only" : "precise";
}

function extractTargets(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): readonly PolicyTarget[] {
  const targets: PolicyTarget[] = [];

  addStringTarget(targets, "path", getString(input, "path"));
  addStringArrayTargets(targets, "path", input.paths);

  switch (toolName) {
    case "bash":
      addStringTarget(targets, "command", getString(input, "command"));
      break;
    case "eval":
    case "python":
      addStringTarget(targets, "code", getString(input, "code"));
      break;
    case "task":
      addStringTarget(targets, "agent", getString(input, "agent"));
      addStringTarget(targets, "agent", getString(input, "name"));
      break;
    case "grep":
      addStringTarget(targets, "query", getString(input, "pattern"));
      break;
    case "glob":
    case "web_search":
      addStringTarget(targets, "query", getString(input, "query"));
      break;
  }

  if (targets.length === 0) {
    targets.push({ kind: "tool", value: toolName });
  }

  return targets;
}

function getString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function addStringArrayTargets(
  targets: PolicyTarget[],
  kind: PolicyTargetKind,
  value: unknown,
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    if (typeof item === "string") {
      addStringTarget(targets, kind, item);
    }
  }
}

function addStringTarget(
  targets: PolicyTarget[],
  kind: PolicyTargetKind,
  value: string | undefined,
): void {
  if (
    value === undefined ||
    targets.some((target) => target.kind === kind && target.value === value)
  ) {
    return;
  }
  targets.push({ kind, value });
}
