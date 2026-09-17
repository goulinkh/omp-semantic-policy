import type { ExtensionAPI, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import {
  applyOmpToolDecision,
  formatCoverageReport,
  normalizeOmpToolCall,
} from "./adapters/omp/index.js";
import { createConservativeFallback, createPolicyGate } from "./policy/index.js";

const STATUS_KEY = "omp-semantic-policy";

export default function ompSemanticPolicy(pi: ExtensionAPI): void {
  const gate = createPolicyGate({
    deterministicEvaluators: [],
    fallbackEvaluator: createConservativeFallback(),
  });
  const toolInfoByName = new Map<string, ToolInfo>();

  pi.setLabel("OMP Semantic Policy");

  pi.on("session_start", (_event, context) => {
    context.ui.setStatus(STATUS_KEY, "policy: conservative fallback");
  });

  pi.on("session_shutdown", (_event, context) => {
    context.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("tool_call", async (event, context) => {
    const action = normalizeOmpToolCall(event, context, {
      toolInfo: findToolInfo(pi, toolInfoByName, event.toolName),
    });
    const decision = await gate.evaluate(action, { headless: !context.hasUI });
    return applyOmpToolDecision(decision, context);
  });

  pi.registerCommand("policy", {
    description: "Show semantic policy status or coverage",
    handler: async (args, context) => {
      const command = args.trim().split(/\s+/, 1).at(0) ?? "status";

      if (command === "coverage") {
        context.ui.notify(formatCoverageReport(), "info");
        return;
      }

      if (command === "status" || command.length === 0) {
        context.ui.notify(
          "Conservative fallback active: reads and workflow tools are allowed; writes, execution, network access, and delegation require approval.",
          "info",
        );
        return;
      }

      context.ui.notify("Usage: /policy [status|coverage]", "warning");
    },
  });
}

function findToolInfo(
  pi: ExtensionAPI,
  toolInfoByName: Map<string, ToolInfo>,
  toolName: string,
): ToolInfo | undefined {
  const cached = toolInfoByName.get(toolName);
  if (cached !== undefined) {
    return cached;
  }

  for (const toolInfo of pi.getAllTools()) {
    toolInfoByName.set(toolInfo.name, toolInfo);
  }

  return toolInfoByName.get(toolName);
}
