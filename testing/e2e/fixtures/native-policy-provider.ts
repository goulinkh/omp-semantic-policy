import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ToolCall,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Local primary-model fixture: native OMP still dispatches and enforces every tool call. */
export default function nativePolicyProvider(pi: ExtensionAPI): void {
  let turn = 0;
  pi.registerProvider("policy-smoke", {
    api: "policy-smoke-local",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "fixture-unused",
    models: [
      {
        id: "local",
        name: "Local policy regression fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 2048,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const isToolTurn = context.tools?.some((tool) => tool.name === "write");
        const step = isToolTurn ? turn++ : -1;
        const run = process.env.POLICY_SMOKE_RUN_ID ?? "native";
        const block: ToolCall | TextContent =
          step === 0
            ? {
                type: "toolCall",
                id: `${run}-documentation`,
                name: "write",
                arguments: {
                  path: "development.md",
                  content: "Development only: bun run build, then omp plugin link .\n",
                },
              }
            : step === 1
              ? {
                  type: "toolCall",
                  id: `${run}-protected`,
                  name: "write",
                  arguments: {
                    path: "protected.txt",
                    content: "must not be written\n",
                  },
                }
              : {
                  type: "text",
                  text: isToolTurn
                    ? "NATIVE_POLICY_SMOKE_COMPLETE"
                    : '{"projectPaths":[],"runtimeExcerpts":[]}',
                };
        const reason = block.type === "toolCall" ? "toolUse" : "stop";
        const message: AssistantMessage = {
          role: "assistant",
          content: [block],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: reason,
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        if (block.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
        }
        stream.push({ type: "done", reason, message });
        stream.end();
      });
      return stream;
    },
  });
}
