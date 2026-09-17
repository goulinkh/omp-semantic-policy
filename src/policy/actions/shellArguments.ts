export const SHELL_WORD_PATTERN = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s"'\\;&|])+/gu;

export interface LiteralShellWord {
  readonly decoded: string;
  readonly rawOffsets: readonly number[];
  readonly expansions: readonly boolean[];
  readonly hasShellOperator: boolean;
}

/** Decode shell quoting only; never evaluate variables, substitutions, globs, or commands. */
export function decodeLiteralShellWord(word: string): LiteralShellWord {
  let quote: "'" | '"' | undefined;
  let decoded = "";
  const rawOffsets: number[] = [];
  const expansions: boolean[] = [];
  let hasShellOperator = false;
  for (let index = 0; index < word.length; index += 1) {
    const character = word[index];
    if (character === undefined) break;
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    const next = word[index + 1];
    if (
      character === "\\" &&
      quote !== "'" &&
      next !== undefined &&
      (quote === undefined || /[$`"\\\n]/u.test(next))
    ) {
      index += 1;
      decoded += next;
      rawOffsets.push(index);
      expansions.push(false);
      continue;
    }
    decoded += character;
    if (quote === undefined && "<>()".includes(character)) hasShellOperator = true;
    rawOffsets.push(index);
    expansions.push(
      (quote !== "'" && (character === "$" || character === "`")) ||
        (quote === undefined && "*?[]{}~".includes(character)),
    );
  }
  return { decoded, rawOffsets, expansions, hasShellOperator };
}

export type ShellPayloadFacts = {
  readonly syntax: "direct-curl";
  readonly scope: "explicit-arguments";
  readonly assessment: "complete" | "unknown";
  readonly fields: {
    readonly name: string;
    readonly value: "empty" | "nonempty" | "expanded-unknown";
    readonly source: "literal" | "expansion" | "unknown";
  }[];
  readonly destinations: {
    readonly value?: string;
    readonly source: "literal" | "expansion" | "unknown";
  }[];
};

/**
 * Facts about supported curl argument syntax, not proof of shell/runtime behavior.
 * Unsupported options, shell composition, and file-backed payloads cannot prove emptiness.
 * Destinations are raw and require boundary redaction; payload values are never returned.
 */
export function selectShellPayloadFacts(command: string): ShellPayloadFacts | undefined {
  if (command.length > 32_000) return undefined;
  const unknown: ShellPayloadFacts = {
    syntax: "direct-curl",
    scope: "explicit-arguments",
    assessment: "unknown",
    fields: [],
    destinations: [{ source: "unknown" }],
  };
  const words: LiteralShellWord[] = [];
  let previousEnd = 0;
  let simple = true;
  for (const match of command.matchAll(SHELL_WORD_PATTERN)) {
    if (!/^[ \t]*$/u.test(command.slice(previousEnd, match.index))) simple = false;
    words.push(decodeLiteralShellWord(match[0]));
    previousEnd = match.index + match[0].length;
    if (words.length > 64) break;
  }
  const executable = words[0];
  if (
    executable === undefined ||
    executable.expansions.some(Boolean) ||
    !/^(?:curl|\/(?:[^/]+\/)*curl)$/u.test(executable.decoded)
  )
    return undefined;
  if (
    !simple ||
    words.length > 64 ||
    words.some((word) => word.hasShellOperator) ||
    !/^\s*$/u.test(command.slice(previousEnd))
  )
    return unknown;

  const fields: ShellPayloadFacts["fields"] = [];
  const destinations: ShellPayloadFacts["destinations"] = [];
  let assessment: ShellPayloadFacts["assessment"] = "complete";
  let hasPayload = false;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) return unknown;
    const equal = word.decoded.indexOf("=");
    const option = equal < 0 ? word.decoded : word.decoded.slice(0, equal);
    const dataOption = ["-d", "--data", "--data-raw", "--data-binary"].includes(option);
    const attachedData =
      !dataOption && word.decoded.startsWith("-d") && !word.decoded.startsWith("--");
    if (dataOption || attachedData) {
      const argument = attachedData || equal >= 0 ? word : words[++index];
      const start = attachedData ? 2 : equal >= 0 ? equal + 1 : 0;
      if (argument === undefined) return unknown;
      const payload = argument.decoded.slice(start);
      hasPayload = true;
      if (option !== "--data-raw" && payload.startsWith("@")) return unknown;
      const parts = payload.split("&");
      let offset = start;
      for (const part of parts) {
        const separator = part.indexOf("=");
        if (separator < 1 || fields.length >= 64) return unknown;
        let name: string;
        try {
          name = decodeURIComponent(part.slice(0, separator).replace(/\+/gu, " "));
        } catch {
          return unknown;
        }
        if (
          !/^[A-Za-z0-9_.-]+$/u.test(name) ||
          argument.expansions.some(
            (flag, position) => flag && position >= offset && position < offset + separator,
          )
        )
          return unknown;
        const expanded = argument.expansions.some(
          (flag, position) =>
            flag && position > offset + separator && position < offset + part.length,
        );
        if (expanded) assessment = "unknown";
        fields.push({
          name,
          value: expanded
            ? "expanded-unknown"
            : part.length === separator + 1
              ? "empty"
              : "nonempty",
          source: expanded ? "expansion" : "literal",
        });
        offset += part.length + 1;
      }
      continue;
    }
    if (["-X", "--request", "-H", "--header"].includes(option)) {
      const argument = equal >= 0 ? word : words[++index];
      if (
        argument === undefined ||
        argument.expansions.some(Boolean) ||
        argument.decoded.startsWith("@")
      )
        return unknown;
      const value = argument.decoded.slice(equal >= 0 ? equal + 1 : 0);
      if (value.startsWith("@")) return unknown;
      if (
        ["-H", "--header"].includes(option) &&
        /^content-type\s*:/iu.test(value) &&
        !/^content-type\s*:\s*application\/x-www-form-urlencoded(?:\s*;.*)?$/iu.test(value)
      )
        return unknown;
      continue;
    }
    if (["-s", "-S", "-sS", "--silent", "--show-error", "-f", "--fail"].includes(word.decoded))
      continue;
    const destination = option === "--url" ? (equal >= 0 ? word : words[++index]) : word;
    if (destination === undefined || (word.decoded.startsWith("-") && option !== "--url"))
      return unknown;
    const destinationStart = option === "--url" && equal >= 0 ? equal + 1 : 0;
    if (destination.expansions.some(Boolean)) {
      if (option !== "--url" && !/^https?:\/\//iu.test(destination.decoded)) return unknown;
      destinations.push({ source: "expansion" });
      assessment = "unknown";
    } else {
      const value = destination.decoded.slice(destinationStart);
      if (!/^https?:\/\/[^\s]+$/iu.test(value)) return unknown;
      destinations.push({ value, source: "literal" });
    }
  }
  if (!hasPayload) return undefined;
  if (destinations.length === 0) return unknown;
  return { syntax: "direct-curl", scope: "explicit-arguments", assessment, fields, destinations };
}
