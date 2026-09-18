import type { ExtensionContext, ToolCallEvent, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import type { PolicyActionDetail } from "../../../policy/actions/types.js";
import { selectShellPayloadFacts } from "../../../policy/actions/shellArguments.js";
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
  ast_edit: "write",
  bash: "execute",
  browser: "execute",
  computer: "execute",
  debug: "execute",
  eval: "execute",
  lsp: "execute",
  hub: "execute",
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
  const inputValid =
    typeof event.input === "object" && event.input !== null && !Array.isArray(event.input);
  const input: Readonly<Record<string, unknown>> = inputValid
    ? (event.input as Readonly<Record<string, unknown>>)
    : {};
  const intent = selectDispatchIntent(event.toolName, input);
  const targets = extractTargets(intent.tool, intent.input);
  const route = getString(input, "path");
  if (intent.tool !== event.toolName) {
    addStringTarget(targets, "tool", route);
  }
  if (intent.tool === "glob" && (input.path === undefined || input.path === null)) {
    addStringTarget(targets, "path", context.cwd);
  }

  return {
    id: event.toolCallId,
    occurredAtMs: (options.now ?? Date.now)(),
    actor: {
      kind: "agent",
      sessionId: context.sessionManager.getSessionId(),
    },
    workingDirectory: context.cwd,
    operation: intent.operation,
    interception: classifyInterception(event.toolName, input, options.toolInfo),
    complete:
      inputValid &&
      intent.complete &&
      targets.length <= MAX_INTENT_ITEMS &&
      targets.reduce((length, target) => length + target.value.length, 0) <= MAX_INTENT_CHARACTERS,
    details: intent.details,
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
): PolicyTarget[] {
  const targets: PolicyTarget[] = [];

  addStringTarget(targets, "path", getString(input, "path"));
  addStringTarget(targets, "url", getString(input, "url"));
  addStringArrayTargets(targets, "path", input.paths);
  addStringTarget(targets, "path", getString(input, "file"));
  if (toolName === "lsp" && input.action === "rename_file") {
    addStringTarget(targets, "path", getString(input, "new_name"));
  }
  addStringTarget(targets, "path", getString(input, "program"));
  if (toolName === "edit" && typeof input.input === "string") {
    for (const match of input.input.matchAll(
      /^\[(.+)#[A-F0-9]{4}\]$|^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^MV (?:"([^"]+)"|(.+))$/gmu,
    )) {
      addStringTarget(targets, "path", match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
    }
  }
  if (toolName === "edit" && Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (typeof edit === "object" && edit !== null) {
        addStringTarget(targets, "path", getString(edit, "rename"));
      }
    }
  }
  addStringArrayTargets(targets, "path", input.files);

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

const MAX_INTENT_CHARACTERS = 32_000;
const MAX_INTENT_ITEMS = 64;
const MAX_INTENT_DEPTH = 4;

interface DispatchIntent {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly operation: PolicyOperation;
  readonly details: Readonly<Record<string, PolicyActionDetail>>;
  readonly complete: boolean;
}

function selectDispatchIntent(
  hostTool: string,
  hostInput: Readonly<Record<string, unknown>>,
): DispatchIntent {
  let tool = hostTool;
  let input = hostInput;
  let complete = true;
  const route = getString(hostInput, "path");
  if (hostTool === "write" && route?.startsWith("xd://")) {
    tool = route.slice("xd://".length);
    const content = hostInput.content;
    if (typeof content !== "string" || content.length > MAX_INTENT_CHARACTERS) {
      complete = false;
      input = {};
    } else {
      try {
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Readonly<Record<string, unknown>>;
        } else {
          input = {};
          complete = false;
        }
      } catch {
        input = {};
        complete = false;
      }
    }
  }

  const details: Record<string, PolicyActionDetail> = { tool };
  let remaining = MAX_INTENT_CHARACTERS;
  function bounded(value: unknown, depth = 0): PolicyActionDetail {
    if (depth > MAX_INTENT_DEPTH) {
      complete = false;
      return "[OMITTED: intent depth limit]";
    }
    if (typeof value === "string") {
      remaining -= value.length;
      if (remaining < 0) {
        complete = false;
        return "[OMITTED: intent size limit]";
      }
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > MAX_INTENT_ITEMS) {
        complete = false;
        return "[OMITTED: intent item limit]";
      }
      return value.map((item: unknown) => bounded(item, depth + 1));
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      if (entries.length > MAX_INTENT_ITEMS) {
        complete = false;
        return "[OMITTED: intent item limit]";
      }
      return Object.fromEntries(
        entries.map(([key, item]) => {
          remaining -= key.length;
          if (remaining < 0) complete = false;
          return [key, bounded(item, depth + 1)];
        }),
      );
    }
    complete = false;
    return "[OMITTED: invalid intent]";
  }
  function select(keys: readonly string[]): void {
    for (const key of keys) {
      if (input[key] !== undefined) details[key] = bounded(input[key]);
    }
  }
  function requireString(key: string): void {
    if (getString(input, key) === undefined) complete = false;
  }
  let operation = classifyOmpToolOperation(tool);
  select(["cwd"]);
  switch (tool) {
    case "task": {
      select(["context"]);
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
        complete = false;
      }
      if (Array.isArray(input.tasks)) {
        if (input.tasks.length > MAX_INTENT_ITEMS) {
          complete = false;
        } else {
          details.tasks = input.tasks.map((task: unknown) => {
            if (typeof task !== "object" || task === null || Array.isArray(task)) {
              complete = false;
              return "[OMITTED: invalid task]";
            }
            if (!("task" in task) || typeof task.task !== "string" || task.task.trim().length === 0)
              complete = false;
            const selected: Record<string, PolicyActionDetail> = {};
            for (const key of ["task", "agent", "name", "tools", "isolated"] as const) {
              if (key in task)
                selected[key] = bounded((task as Readonly<Record<string, unknown>>)[key], 1);
            }
            return selected;
          });
        }
      }
      if (input.context !== undefined && typeof input.context !== "string") complete = false;
      break;
    }
    case "bash":
      select(["command", "env"]);
      requireString("command");
      if (typeof input.command === "string") {
        const shellPayload = selectShellPayloadFacts(input.command);
        if (shellPayload !== undefined) details.shellPayload = shellPayload;
      }
      break;
    case "eval":
    case "python":
      select(["code", "language", "reset"]);
      requireString("code");
      break;
    case "browser":
    case "computer": {
      select([
        "action",
        "name",
        "url",
        "code",
        "fn",
        "args",
        "read_only",
        "all",
        "kill",
        "persist",
        "dialogs",
        "viewport",
      ]);
      if (tool === "browser" && input.app !== undefined) {
        if (typeof input.app !== "object" || input.app === null || Array.isArray(input.app)) {
          complete = false;
        } else {
          const app = input.app as Readonly<Record<string, unknown>>;
          details.app = Object.fromEntries(
            ["path", "cdp_url", "relay", "args", "target"]
              .filter((key) => app[key] !== undefined)
              .map((key) => [key, bounded(app[key], 1)]),
          );
        }
      }
      const action = getString(input, "action");
      if (action === "run") {
        if (getString(input, "code") === undefined && getString(input, "fn") === undefined)
          complete = false;
        if (input.args !== undefined && !Array.isArray(input.args)) complete = false;
      } else if (action === "call") {
        if (
          !Array.isArray(input.chain) ||
          input.chain.length === 0 ||
          input.chain.length > MAX_INTENT_ITEMS
        ) {
          complete = false;
        } else {
          details.chain = input.chain.map((step: unknown) => {
            if (
              typeof step !== "object" ||
              step === null ||
              !("method" in step) ||
              typeof step.method !== "string" ||
              step.method.length === 0 ||
              !("args" in step) ||
              !Array.isArray(step.args)
            ) {
              complete = false;
              return "[OMITTED: invalid invocation]";
            }
            return bounded({ method: step.method, args: step.args }, 1);
          });
        }
      } else if (
        action !== "close" &&
        !(tool === "browser" && action === "open") &&
        !(tool === "computer" && action === "capabilities")
      ) {
        complete = false;
      }
      break;
    }
    case "ast_edit":
      if (
        !Array.isArray(input.paths) ||
        input.paths.length === 0 ||
        !input.paths.every((path: unknown) => typeof path === "string" && path.length > 0)
      )
        complete = false;
      if (
        !Array.isArray(input.ops) ||
        input.ops.length === 0 ||
        input.ops.length > MAX_INTENT_ITEMS
      ) {
        complete = false;
      } else {
        details.ops = input.ops.map((op: unknown) => {
          if (
            typeof op !== "object" ||
            op === null ||
            !("pat" in op) ||
            typeof op.pat !== "string" ||
            op.pat.length === 0 ||
            !("out" in op) ||
            typeof op.out !== "string"
          ) {
            complete = false;
            return "[OMITTED: invalid rewrite]";
          }
          return bounded({ pat: op.pat, out: op.out }, 1);
        });
      }
      break;
    case "hub": {
      select([
        "op",
        "operation",
        "application",
        "args",
        "env",
        "name",
        "to",
        "message",
        "text",
        "keys",
        "signal",
      ]);
      const op = getString(input, "op") ?? getString(input, "operation");
      if (op === "start") {
        requireString("application");
        if (
          input.args !== undefined &&
          (!Array.isArray(input.args) ||
            !input.args.every((arg: unknown) => typeof arg === "string"))
        )
          complete = false;
      } else if (op === "send") {
        if (
          !["message", "text", "signal"].some((key) => getString(input, key) !== undefined) &&
          !(
            Array.isArray(input.keys) &&
            input.keys.length > 0 &&
            input.keys.every((key: unknown) => typeof key === "string")
          )
        )
          complete = false;
        if (!["name", "to"].some((key) => getString(input, key) !== undefined)) complete = false;
      } else if (op === "restart" || op === "stop") {
        requireString("name");
      } else if (
        op === undefined ||
        ![
          "wait",
          "list",
          "inbox",
          "jobs",
          "cancel",
          "ps",
          "logs",
          "stop",
          "restart",
          "describe",
        ].includes(op)
      ) {
        complete = false;
      }
      break;
    }
    case "debug":
      select([
        "action",
        "program",
        "args",
        "file",
        "line",
        "function",
        "name",
        "expression",
        "condition",
        "hit_condition",
        "command",
        "arguments",
        "data",
        "memory_reference",
        "instruction_reference",
        "pid",
        "port",
        "host",
        "env",
        "adapter",
        "context",
        "frame_id",
        "scope_id",
        "variable_ref",
        "data_id",
        "access_type",
        "count",
        "offset",
      ]);
      requireString("action");
      if (input.action === "launch") requireString("program");
      if (input.action === "evaluate") requireString("expression");
      if (input.action === "custom_request") requireString("command");
      if (
        ![
          "launch",
          "attach",
          "set_breakpoint",
          "remove_breakpoint",
          "set_instruction_breakpoint",
          "remove_instruction_breakpoint",
          "data_breakpoint_info",
          "set_data_breakpoint",
          "remove_data_breakpoint",
          "continue",
          "step_over",
          "step_in",
          "step_out",
          "pause",
          "evaluate",
          "stack_trace",
          "threads",
          "scopes",
          "variables",
          "disassemble",
          "read_memory",
          "write_memory",
          "modules",
          "loaded_sources",
          "custom_request",
          "output",
          "terminate",
          "sessions",
        ].includes(getString(input, "action") ?? "")
      )
        complete = false;
      break;
    case "lsp": {
      select([
        "action",
        "operation",
        "file",
        "path",
        "files",
        "line",
        "character",
        "symbol",
        "newName",
        "new_name",
        "apply",
        "query",
        "code",
        "edits",
      ]);
      const action = getString(input, "action") ?? getString(input, "operation");
      if (
        action !== undefined &&
        [
          "references",
          "definition",
          "type_definition",
          "implementation",
          "hover",
          "diagnostics",
          "symbols",
          "workspace_symbols",
          "document_symbols",
          "status",
          "capabilities",
        ].includes(action)
      ) {
        operation = "read";
      } else if (
        action !== undefined &&
        ["rename", "rename_file", "code_actions", "format", "reload"].includes(action)
      ) {
        operation = "write";
      } else {
        complete = false;
      }
      if (
        !["status", "capabilities", "reload", "symbols"].includes(action ?? "") &&
        getString(input, "file") === undefined &&
        getString(input, "path") === undefined &&
        !(
          Array.isArray(input.files) &&
          input.files.length > 0 &&
          input.files.every((file: unknown) => typeof file === "string" && file.length > 0)
        )
      )
        complete = false;
      if (action === "rename" || action === "rename_file") requireString("new_name");
      break;
    }
    case "edit":
      select(["input", "path", "old_string", "new_string", "replace_all", "edits"]);
      if (input.input !== undefined) {
        requireString("input");
      } else {
        requireString("path");
        if (input.edits !== undefined) {
          if (
            !Array.isArray(input.edits) ||
            input.edits.length === 0 ||
            !input.edits.every(
              (edit: unknown) =>
                typeof edit === "object" &&
                edit !== null &&
                (("old_string" in edit &&
                  typeof edit.old_string === "string" &&
                  "new_string" in edit &&
                  typeof edit.new_string === "string") ||
                  ("diff" in edit && typeof edit.diff === "string") ||
                  ("op" in edit && edit.op === "delete") ||
                  ("rename" in edit && typeof edit.rename === "string")),
            )
          )
            complete = false;
        } else if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
          complete = false;
        }
      }
      if (
        getString(input, "path") === undefined &&
        extractTargets(tool, input).every((target) => target.kind !== "path")
      )
        complete = false;
      break;
    case "write":
      select(["path", "content"]);
      requireString("path");
      if (typeof input.content !== "string") complete = false;
      break;
    case "read":
      requireString("path");
      break;
    case "glob":
      if (input.path !== undefined && input.path !== null && typeof input.path !== "string")
        complete = false;
      break;
    case "grep":
      select(["pattern"]);
      requireString("pattern");
      break;
    case "web_search":
      select(["query"]);
      requireString("query");
      break;
    case "ask":
    case "todo":
      break;
    default:
      // Unknown dispatch schemas cannot be represented faithfully by guessing fields.
      complete = false;
  }
  return { tool, input, operation, details, complete };
}
