import { settings, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { basename, isAbsolute, relative } from "node:path";
import {
  decodeLiteralShellWord,
  SHELL_WORD_PATTERN,
} from "../../../policy/actions/shellArguments.js";
import type { PolicyAction, PolicyDecision } from "../../../policy/index.js";
import { redactText } from "../../typesafe/redactProviderState.js";
import { brandPolicyText } from "../policyIdentity.js";

const PLUGIN_NAME = "omp-semantic-policy";

export const DEFAULT_ENABLED_TOOL_CALLS: readonly string[] = [
  "bash",
  "eval",
  "python",
  "write",
  "edit",
  "task",
  "hub",
  "browser",
  "computer",
  "debug",
];

export type AutomaticConfirmationDefault = "approve" | "deny";

export interface PolicyRuntimeSettings {
  readonly showStatus: boolean;
  readonly showViolationFeedback: boolean;
  readonly confirmationDefault: AutomaticConfirmationDefault;
  readonly confirmationThreshold: number;
  readonly disabledToolCalls: readonly string[];
  readonly enabledToolCalls: readonly string[];
}

export interface PolicyStatusBarController {
  configure(visible: boolean): void;
}

export interface PolicyStatusBarHost {
  getLeftSegments(): readonly string[];
  getRightSegments(): readonly string[];
  setRightSegments(segments: readonly string[]): void;
  setHookRowsVisible(visible: boolean): void;
}

export async function loadPolicyRuntimeSettings(
  cwd: string,
  overrides: Partial<PolicyRuntimeSettings> = {},
): Promise<PolicyRuntimeSettings> {
  let configured: Record<string, unknown> = {};
  if (
    overrides.showStatus === undefined ||
    overrides.showViolationFeedback === undefined ||
    overrides.confirmationDefault === undefined ||
    overrides.confirmationThreshold === undefined ||
    overrides.disabledToolCalls === undefined ||
    overrides.enabledToolCalls === undefined
  ) {
    try {
      configured = await getPluginSettings(PLUGIN_NAME, cwd);
    } catch {
      configured = {};
    }
  }

  const confirmationDefault =
    overrides.confirmationDefault ?? configured.confirmationDefault ?? "approve";
  const confirmationThreshold = normalizeConfirmationThreshold(
    overrides.confirmationThreshold ?? configured.confirmationThreshold,
  );
  const disabledToolCalls = normalizeToolCallNames(
    overrides.disabledToolCalls ?? configured.disabledToolCalls,
  );
  const enabledToolCalls = normalizeToolCallNames(
    overrides.enabledToolCalls ?? configured.enabledToolCalls ?? DEFAULT_ENABLED_TOOL_CALLS,
  );
  return {
    showStatus: overrides.showStatus ?? configured.showStatus !== false,
    showViolationFeedback:
      overrides.showViolationFeedback ?? configured.showViolationFeedback !== false,
    confirmationDefault: confirmationDefault === "approve" ? "approve" : "deny",
    confirmationThreshold,
    disabledToolCalls,
    enabledToolCalls,
  };
}

function normalizeConfirmationThreshold(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 1;
}

function normalizeToolCallNames(value: unknown): readonly string[] {
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return [
    ...new Set(
      items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

/** Move extension statuses into OMP's native status segment instead of a separate footer row. */
export function createPolicyStatusBarController(
  host: PolicyStatusBarHost = createOmpStatusBarHost(),
): PolicyStatusBarController {
  let configured = false;
  return {
    configure(visible) {
      if (!visible || configured) {
        return;
      }
      try {
        const left = host.getLeftSegments();
        const right = host.getRightSegments();
        if (!left.includes("status") && !right.includes("status")) {
          host.setRightSegments(["status", ...right]);
        }
        host.setHookRowsVisible(false);
        configured = true;
      } catch {
        // Non-TUI hosts may not initialize OMP's Settings singleton.
      }
    },
  };
}

function createOmpStatusBarHost(): PolicyStatusBarHost {
  return {
    getLeftSegments: () => settings.get("statusLine.leftSegments"),
    getRightSegments: () => settings.get("statusLine.rightSegments"),
    setRightSegments: (segments) => {
      const current = settings.get("statusLine.rightSegments");
      settings.override("statusLine.rightSegments", [...segments] as typeof current);
    },
    setHookRowsVisible: (visible) => {
      settings.override("statusLine.showHookStatus", visible);
    },
  };
}

export function formatPolicyDecisionFeedback(
  decision: Exclude<PolicyDecision, { effect: "allow" }>,
  action: PolicyAction,
): string;
export function formatPolicyDecisionFeedback(
  decision: PolicyDecision,
  action: PolicyAction,
): string | undefined;
export function formatPolicyDecisionFeedback(
  decision: PolicyDecision,
  action: PolicyAction,
): string | undefined {
  if (decision.effect === "allow") return undefined;

  const tool = safeFeedbackText(action.hostAction.name, 64);
  const title =
    decision.effect === "deny"
      ? `${tool} blocked`
      : decision.effect === "prompt"
        ? `Approval needed for ${tool}`
        : `${tool} revised`;
  const diagnostics = decision.evidence.diagnostics;
  const resolution = diagnostics?.confirmation.resolution;
  const confirmationBlocked =
    resolution === "automatic-deny" ||
    resolution === "headless-denied" ||
    resolution === "user-denied" ||
    (resolution === "pending" && decision.effect === "deny");
  const decisive = diagnostics?.decisiveRule;
  const rule =
    !confirmationBlocked &&
    decision.effect === "deny" &&
    decisive !== undefined &&
    decision.evidence.ruleIds.includes(decisive.ruleId)
      ? decisive
      : undefined;
  let explanation: string;
  if (rule?.statement !== undefined) {
    const context = rule.context ?? [];
    const prohibition = context.some((heading) => /^(?:don't|don’t|do not|never)$/iu.test(heading));
    let heading: string | undefined;
    for (let index = context.length - 1; index >= 0; index -= 1) {
      const entry = context[index];
      if (entry !== undefined && !/^(?:do|don't|don’t|do not|never|examples?)$/iu.test(entry)) {
        heading = entry;
        break;
      }
    }
    explanation = [
      ...(heading === undefined ? [] : [`Rule: ${safeFeedbackText(heading, 100)}`]),
      `${prohibition ? "Not allowed" : "Requirement"}: ${safeFeedbackText(rule.statement, 240)}`,
    ].join("\n");
  } else if (diagnostics?.path === "provider-unavailable") {
    explanation = safeFeedbackText(decision.reason, 240);
  } else if (confirmationBlocked) {
    explanation =
      resolution === "user-denied"
        ? "You declined approval for this action."
        : "The action could not be approved. No policy violation was established.";
  } else if (diagnostics?.path === "semantic") {
    explanation =
      decision.effect === "deny"
        ? "The policy assessment found a conflict."
        : "The policy assessment needs your approval.";
  } else {
    explanation = safeFeedbackText(decision.reason, 240);
  }
  if (rule?.sourcePath !== undefined) {
    const localPath = relative(action.workingDirectory, rule.sourcePath);
    const source =
      localPath === ".." || localPath.startsWith("../") || isAbsolute(localPath)
        ? basename(rule.sourcePath)
        : localPath;
    explanation += `\nSource: ${safeFeedbackText(source, 140)}`;
  }
  const recovery =
    decision.effect === "prompt"
      ? "Approve this action to continue."
      : confirmationBlocked
        ? "Review approval settings if this should be allowed."
        : diagnostics?.path === "incomplete-action"
          ? "Provide complete tool arguments and retry."
          : "Revise the action to follow the rule.";
  return brandPolicyText(
    [
      `${title}\n${summarizeAction(action)}${summarizeExecutionContext(action)}`,
      explanation,
      `${recovery}\nDetails: /policy audit`,
    ].join("\n\n"),
  );
}

function safeFeedbackText(value: string, limit: number): string {
  const text = redactText(
    sanitizeText(value).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, ""),
  )
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function summarizeExecutionContext(action: PolicyAction): string {
  if (action.operation !== "execute") return "";
  const cwd = typeof action.details.cwd === "string" ? action.details.cwd : action.workingDirectory;
  const env = action.details.env;
  const keys =
    env !== null && typeof env === "object" && !Array.isArray(env) ? Object.keys(env) : [];
  const overrides =
    keys.length === 0
      ? ""
      : `; environment overrides: ${keys
          .slice(0, 5)
          .map((key) => safeFeedbackText(key, 32))
          .join(", ")}${keys.length > 5 ? ", …" : ""} (values omitted)`;
  return `\nWorking directory: ${safeFeedbackText(cwd, 180)}${overrides}`;
}

function summarizeAction(action: PolicyAction): string {
  const command = action.targets.find((target) => target.kind === "command");
  if (command !== undefined) return summarizeCommand(command.value);
  const paths = action.targets.filter((target) => target.kind === "path");
  if (paths.length > 0) {
    return `${paths
      .slice(0, 2)
      .map((target) => safeFeedbackText(target.value, 160))
      .join(", ")}${paths.length > 2 ? ", …" : ""}`;
  }
  if (action.targets.some((target) => target.kind === "code")) return "code omitted";
  return `${action.operation} action`;
}

function summarizeCommand(command: string): string {
  // Preserve ordinary command identity, but never print inline programs or heredoc bodies.
  if (command.length > 32_000) return "shell command (details omitted)";
  command = sanitizeText(command).replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "");
  let end = command.indexOf("\n");
  if (end === -1) end = command.length;
  const heredoc = command.indexOf("<<");
  if (heredoc !== -1) end = Math.min(end, heredoc);
  let interpreter = false;
  for (const match of command.slice(0, end).matchAll(SHELL_WORD_PATTERN)) {
    const word = decodeLiteralShellWord(match[0]).decoded;
    const executable = word.slice(word.lastIndexOf("/") + 1);
    if (executable === "eval") {
      end = match.index + match[0].length;
      break;
    }
    if (
      /^(?:ba|da|z|k|fi)?sh$|^(?:node(?:js)?|bun|deno|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|pwsh|powershell)$/u.test(
        executable,
      )
    )
      interpreter = true;
    if (
      interpreter &&
      /^(?:-[A-Za-z]*[cepr]|--(?:eval|print|command)(?:=|$)|-(?:EncodedCommand|Command)$)/iu.test(
        word,
      )
    ) {
      end = match.index;
      break;
    }
  }
  const summary = safeFeedbackText(command.slice(0, end), 200);
  return `${summary || "shell command"}${end < command.length ? " (remaining command omitted)" : ""}`;
}

export function stylePolicyDecisionFeedback(
  feedback: string,
  decision: PolicyDecision,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const style =
    decision.effect === "deny"
      ? { background: "toolErrorBg" as const, foreground: "error" as const }
      : decision.effect === "prompt"
        ? { background: "toolPendingBg" as const, foreground: "warning" as const }
        : { background: "customMessageBg" as const, foreground: "accent" as const };
  const padded = ` ${feedback} `;
  return theme.bgFill(
    style.background,
    theme.bold(theme.fgOnBg(style.foreground, style.background, padded)),
  );
}
