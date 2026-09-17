import type { ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { PolicyDecision } from "../../../policy/index.js";

const POLICY_DIALOG_TITLE = "OMP Semantic Policy";
export interface OmpDecisionContext {
  readonly hasUI: ExtensionContext["hasUI"];
  readonly ui: Pick<ExtensionContext["ui"], "confirm">;
}

/** Translate a policy decision into OMP's pre-tool execution contract. */
export async function applyOmpToolDecision(
  decision: PolicyDecision,
  context: OmpDecisionContext,
): Promise<ToolCallEventResult | undefined> {
  switch (decision.effect) {
    case "allow":
      return undefined;
    case "deny":
      return { block: true, reason: decision.reason };
    case "revise":
      return { input: { ...decision.input } };
    case "prompt": {
      if (!context.hasUI) {
        return {
          block: true,
          reason: `Policy approval required but no interactive UI is available: ${decision.reason}`,
        };
      }

      const approved = await context.ui.confirm(POLICY_DIALOG_TITLE, decision.reason);
      return approved
        ? undefined
        : { block: true, reason: `User denied policy approval: ${decision.reason}` };
    }
  }
}
