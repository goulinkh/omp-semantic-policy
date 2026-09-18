import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AuthorizationEnvelope } from "../../../policy/actions/types.js";

type RequestContext = NonNullable<AuthorizationEnvelope["requestContext"]>;

/** Read only recent human text and the preceding assistant proposal, not tool bodies or thinking. */
export function collectShellRequestContext(
  session: ExtensionContext["sessionManager"],
  currentRequest?: string,
): RequestContext | undefined {
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  let remaining = 4_000;
  let partial = false;
  let users = 0;
  let proposal = false;
  if (currentRequest !== undefined) {
    if (currentRequest.length > remaining) return { status: "partial", messages: [] };
    messages.push({ role: "user", text: currentRequest });
    remaining -= currentRequest.length;
    users = 1;
  }
  // Minimal embedding hosts may not expose transcript traversal.
  if (typeof session.getLeafEntry === "function" && typeof session.getEntry === "function") {
    let entry = session.getLeafEntry();
    let skipCurrent = currentRequest !== undefined;
    let visited = 0;
    while (entry !== undefined && users < 2 && visited++ < 64) {
      if (entry.type === "compaction" || entry.type === "reset_boundary") {
        partial = true;
        break;
      }
      if (entry.type === "message") {
        const message = entry.message;
        if (
          (message.role === "user" &&
            (!("attribution" in message) || message.attribution === "user")) ||
          (message.role === "assistant" && users === 1 && !proposal)
        ) {
          const content = message.content;
          let text = typeof content === "string" ? content : "";
          if (typeof content !== "string") {
            if (message.role === "user" && content.some((part) => part.type !== "text"))
              partial = true;
            for (const part of content) {
              if (part.type !== "text" || !("text" in part) || typeof part.text !== "string")
                continue;
              text += `${text.length === 0 ? "" : "\n"}${part.text}`;
              if (text.length > remaining) break;
            }
          }
          if (message.role === "user" && text.length === 0) {
            partial = true;
            break;
          }
          if (text.length > 0) {
            if (skipCurrent && message.role === "user" && text === currentRequest) {
              skipCurrent = false;
            } else {
              skipCurrent = false;
              if (text.length > remaining) {
                partial = true;
                break;
              }
              messages.push({ role: message.role, text });
              remaining -= text.length;
              if (message.role === "user") users++;
              else proposal = true;
            }
          }
        }
      }
      entry = entry.parentId === null ? undefined : session.getEntry(entry.parentId);
    }
    if (entry !== undefined && users < 2 && visited >= 64) partial = true;
  }
  return messages.length === 0 && !partial
    ? undefined
    : { status: partial ? "partial" : "included", messages: messages.reverse() };
}
