import { settings, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { PolicyDecision } from "../../../policy/index.js";
import { brandPolicyText } from "../policyIdentity.js";

const PLUGIN_NAME = "omp-semantic-policy";

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
    overrides.confirmationDefault ?? configured.confirmationDefault ?? "deny";
  const confirmationThreshold = normalizeConfirmationThreshold(
    overrides.confirmationThreshold ?? configured.confirmationThreshold,
  );
  const disabledToolCalls = normalizeToolCallNames(
    overrides.disabledToolCalls ?? configured.disabledToolCalls,
  );
  const enabledToolCalls = normalizeToolCallNames(
    overrides.enabledToolCalls ?? configured.enabledToolCalls,
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

export function formatPolicyDecisionFeedback(decision: PolicyDecision): string | undefined {
  switch (decision.effect) {
    case "allow":
      return undefined;
    case "deny":
      return brandPolicyText(`Policy: denied · ${decision.reason}`);
    case "prompt":
      return brandPolicyText(`Policy: warning · approval required · ${decision.reason}`);
    case "revise":
      return brandPolicyText(`Policy: revised · ${decision.reason}`);
  }
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
