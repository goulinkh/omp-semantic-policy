import { completeSimple, type AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { StandardsModelCompletion } from "../onboarding/createStandardsSourceResolver.js";

/** Use OMP's active/default model and credential routing for standards discovery. */
export function createDefaultModelStandardsCompletion(
  getContext: () => ExtensionContext | undefined,
): StandardsModelCompletion {
  return async (prompt, signal) => {
    const context = getContext();
    if (context === undefined) {
      return undefined;
    }

    try {
      const model = context.models.current() ?? context.model;
      if (model === undefined) {
        return undefined;
      }
      const sessionId = context.sessionManager.getSessionId();
      const apiKey = await context.modelRegistry.getApiKey(model, sessionId, { signal });
      if (apiKey === undefined || apiKey.trim().length === 0) {
        return undefined;
      }
      const response = await completeSimple(
        model,
        {
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        {
          apiKey,
          sessionId,
          maxTokens: 2_048,
          temperature: 0,
          disableReasoning: true,
          signal,
        },
      );
      if (response.stopReason === "error") {
        return undefined;
      }
      const text = extractText(response.content);
      return text.length === 0 ? undefined : text;
    } catch {
      return undefined;
    }
  };
}

function extractText(content: AssistantMessage["content"]): string {
  return content
    .filter(
      (block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
