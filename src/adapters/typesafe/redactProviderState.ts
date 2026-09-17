import type { EntryType, JsonValue } from "@typesafe-ai/sdk";
import type { AuthorizationEnvelope, PolicyActionDetail } from "../../policy/actions/types.js";
import type {
  PolicyModelRequest,
  PolicyOperation,
  InterceptionCapability,
  PolicyTarget,
} from "../../policy/index.js";
import type { PolicyRuleClass } from "../../policy/sources/types.js";
import { selectApplicableRules } from "../../policy/sources/selectApplicableRules.js";
import { decodeLiteralShellWord, SHELL_WORD_PATTERN } from "../../policy/actions/shellArguments.js";

const CREDENTIAL_NAME = String.raw`[A-Z0-9_-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION)[A-Z0-9_-]*`;
const CREDENTIAL_KEY = new RegExp(String.raw`^(?:${CREDENTIAL_NAME})$`, "iu");
const CREDENTIAL_PREFIX = String.raw`\b${CREDENTIAL_NAME}[ \t]*[=:][ \t]*`;
const QUOTED_VALUE = String.raw`\\"(?:\\.|[^"\\])*\\"|"(?:\\.|[^"\\])*"|'[^']*'`;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1|(${CREDENTIAL_PREFIX})((?:${QUOTED_VALUE}|\\.|[^\s"'&;,|\\])+)`,
  "giu",
);
const QUOTED_CREDENTIAL_FIELDS = new RegExp(
  String.raw`(${CREDENTIAL_PREFIX})((?:${QUOTED_VALUE}|\\.|[^"'&;,\\])+)`,
  "giu",
);
const JSON_CREDENTIAL_FIELDS = new RegExp(
  String.raw`((?:\\?["'])${CREDENTIAL_NAME}(?:\\?["'])[ \t]*:[ \t]*)(${QUOTED_VALUE}|null|true|false|-?\d+(?:\.\d+)?)`,
  "giu",
);

const ASSEMBLED_CREDENTIAL_FIELD = new RegExp(String.raw`(${CREDENTIAL_PREFIX})([^&;,]*)`, "giu");
const ASSEMBLED_CREDENTIAL_PREFIX = new RegExp(CREDENTIAL_PREFIX, "giu");

/**
 * Recognize literal quote concatenation, not shell execution. Canonicalize only words
 * whose credential key crosses quote boundaries; markers retain the value's uncertainty.
 */
function redactFragmentedCredentialKeys(text: string): string {
  return text.replace(SHELL_WORD_PATTERN, (word) => {
    if (!/['"]/u.test(word)) return word;
    const { decoded, rawOffsets, expansions } = decodeLiteralShellWord(word);
    let fragmented = false;
    for (const match of decoded.matchAll(ASSEMBLED_CREDENTIAL_PREFIX)) {
      const start = rawOffsets[match.index];
      const delimiter = match[0].search(/[=:]/u);
      const keyLength = match[0].slice(0, delimiter).trimEnd().length;
      // A quoted JSON key followed by ':' is not shell concatenation.
      const end =
        rawOffsets[match.index + (match[0][delimiter] === "=" ? delimiter : keyLength - 1)];
      if (start !== undefined && end !== undefined && /['"]/u.test(word.slice(start, end + 1))) {
        fragmented = true;
        break;
      }
    }
    if (!fragmented) return word;
    const redacted = decoded.replace(
      ASSEMBLED_CREDENTIAL_FIELD,
      (_match, prefix: string, credential: string, offset: number) => {
        if (credential.length === 0) return prefix;
        const start = offset + prefix.length;
        const expansion = expansions.some(
          (flag, index) => flag && index >= start && index < start + credential.length,
        );
        return `${prefix}${expansion ? "[REDACTED:EXPANSION]" : "[REDACTED:NONEMPTY]"}`;
      },
    );
    // This is evidence, not a runnable shell rewrite. Quoting retains word boundaries.
    return JSON.stringify(redacted);
  });
}

// Markers describe withheld values; they are not executable replacement credentials.
function redactCredentialValue(value: string, outerQuote?: string): string {
  return value.replace(
    /\\"((?:\\.|[^"\\])*)\\"|"((?:\\.|[^"\\])*)"|'([^']*)'|(?:\\.|[^"'\\])+/gu,
    (
      segment,
      escapedDoubleQuoted: string | undefined,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
    ) => {
      const literal = escapedDoubleQuoted ?? doubleQuoted ?? singleQuoted ?? segment;
      if (literal.length === 0 || /^\[REDACTED:(?:NONEMPTY|EXPANSION|UNKNOWN)\]$/u.test(literal))
        return segment;
      const expandable = outerQuote === '"' || (outerQuote !== "'" && singleQuoted === undefined);
      const marker =
        expandable && /[$`]/u.test(literal) ? "[REDACTED:EXPANSION]" : "[REDACTED:NONEMPTY]";
      if (escapedDoubleQuoted !== undefined) return `\\"${marker}\\"`;
      if (doubleQuoted !== undefined) return `"${marker}"`;
      if (singleQuoted !== undefined) return `'${marker}'`;
      return marker;
    },
  );
}

/** Remove credential values without turning expansions into known empty or nonempty literals. */
export function redactText(value: string): string {
  return redactFragmentedCredentialKeys(value)
    .replace(
      JSON_CREDENTIAL_FIELDS,
      (_match, prefix: string, credential: string) =>
        `${prefix}${credential === "null" ? '"[REDACTED:UNKNOWN]"' : redactCredentialValue(credential)}`,
    )
    .replace(
      /\b(authorization\s*:\s*bearer\s+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/giu,
      (_match, prefix: string, credential: string) =>
        `${prefix}${redactCredentialValue(credential)}`,
    )
    .replace(
      CREDENTIAL_ASSIGNMENT,
      (
        _match,
        quote: string | undefined,
        fields: string | undefined,
        prefix: string | undefined,
        credential: string | undefined,
      ) =>
        quote === undefined
          ? `${prefix ?? ""}${redactCredentialValue(credential ?? "")}`
          : `${quote}${(fields ?? "").replace(
              QUOTED_CREDENTIAL_FIELDS,
              (_field, fieldPrefix: string, fieldValue: string) =>
                `${fieldPrefix}${redactCredentialValue(fieldValue, quote)}`,
            )}${quote}`,
    )
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu, "[REDACTED:NONEMPTY]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED:NONEMPTY]@");
}

export type RedactedProviderState = {
  readonly policy: {
    readonly snapshotId: string;
    readonly rules: {
      readonly id: string;
      readonly class: PolicyRuleClass;
      readonly statement: string;
      readonly sourceId: string;
      readonly precedence: number;
      readonly context?: string[];
    }[];
  };
  readonly action: {
    readonly operation: PolicyOperation;
    readonly interception: InterceptionCapability;
    readonly complete: boolean;
    readonly details: Readonly<Record<string, JsonValue>>;
    readonly targets: { readonly kind: PolicyTarget["kind"]; readonly value: string }[];
    readonly host: string;
    readonly name: string;
  };
  readonly authorization: {
    readonly source: AuthorizationEnvelope["source"];
    readonly explicit: boolean;
    readonly scope?: "request" | "exact-action";
    readonly actionDigest?: string;
    readonly summary?: string;
  };
};

/** Build the only payload permitted to cross the semantic provider boundary. */
export function createRedactedProviderState(request: PolicyModelRequest): RedactedProviderState {
  let complete = request.action.complete === true;
  let remaining = 32_000;
  const command = request.action.details.command;
  const shell = request.action.details.shellPayload;
  const redactedCommand =
    typeof command === "string" &&
    command.length <= 32_000 &&
    (request.action.hostAction.name === "bash" || request.action.hostAction.name === "user_bash") &&
    shell !== null &&
    typeof shell === "object" &&
    !Array.isArray(shell) &&
    "syntax" in shell &&
    shell.syntax === "direct-curl" &&
    "scope" in shell &&
    shell.scope === "explicit-arguments" &&
    "assessment" in shell &&
    shell.assessment === "complete"
      ? command.replace(SHELL_WORD_PATTERN, (word) => redactText(word))
      : undefined;
  function redactDetail(value: PolicyActionDetail, depth = 0, credential = false): JsonValue {
    if (credential) {
      if (typeof value === "string") return value.length === 0 ? "" : "[REDACTED:NONEMPTY]";
      if (typeof value === "number" || typeof value === "boolean") return "[REDACTED:NONEMPTY]";
      return "[REDACTED:UNKNOWN]";
    }
    if (depth > 6) {
      complete = false;
      return "[OMITTED: intent depth limit]";
    }
    if (typeof value === "string") {
      remaining -= value.length;
      if (remaining < 0) {
        complete = false;
        return "[OMITTED: intent size limit]";
      }
      return value === command && redactedCommand !== undefined
        ? redactedCommand
        : redactText(value);
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) {
      if (value.length > 64) {
        complete = false;
        return "[OMITTED: intent item limit]";
      }
      return value.map((item: PolicyActionDetail, index: number) => {
        const previous: unknown = value[index - 1];
        const followsCredentialFlag =
          typeof previous === "string" &&
          /^--?/u.test(previous) &&
          CREDENTIAL_KEY.test(previous.replace(/^--?/u, ""));
        return redactDetail(item, depth + 1, followsCredentialFlag);
      });
    }
    const entries = Object.entries(value);
    if (entries.length > 64) {
      complete = false;
      return "[OMITTED: intent item limit]";
    }
    return Object.fromEntries(
      entries.map(([key, item]: [string, PolicyActionDetail]) => [
        redactText(key),
        redactDetail(item, depth + 1, CREDENTIAL_KEY.test(key)),
      ]),
    );
  }
  const details: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(request.action.details ?? {})) {
    details[redactText(key)] = redactDetail(value, 0, CREDENTIAL_KEY.test(key));
  }
  const targets: { kind: PolicyTarget["kind"]; value: string }[] = [];
  if (request.action.targets.length > 64) {
    complete = false;
  } else {
    for (const target of request.action.targets) {
      const value = redactDetail(target.value);
      if (typeof value === "string") targets.push({ kind: target.kind, value });
    }
  }
  return {
    policy: {
      snapshotId: request.snapshot.id,
      rules: selectApplicableRules(request.snapshot, request.action).map((rule) => ({
        id: rule.id,
        class: rule.classification,
        statement: redactText(rule.statement),
        sourceId: rule.sourceId,
        precedence: rule.precedence,
        ...(rule.context === undefined ? {} : { context: rule.context.map(redactText) }),
      })),
    },
    action: {
      operation: request.action.operation,
      interception: request.action.interception,
      complete,
      details,
      targets,
      host: redactText(request.action.hostAction.host),
      name: redactText(request.action.hostAction.name),
    },
    authorization: {
      source: request.authorization?.source ?? "none",
      explicit: request.authorization?.explicit ?? false,
      ...(request.authorization?.scope === undefined ? {} : { scope: request.authorization.scope }),
      ...(request.authorization?.actionDigest === undefined
        ? {}
        : { actionDigest: request.authorization.actionDigest }),
      ...(request.authorization?.summary === undefined
        ? {}
        : { summary: redactText(request.authorization.summary) }),
    },
  } satisfies EntryType;
}
