export interface PolicyCommandCompletion {
  readonly label: string;
  readonly value: string;
  readonly description: string;
}

export interface PolicyCommandInvocation {
  readonly command: string;
  readonly value?: string;
  readonly actionId?: string;
  readonly path?: string;
}

const POLICY_SUBCOMMANDS: readonly PolicyCommandCompletion[] = [
  { label: "status", value: "status ", description: "Show the active project policy" },
  { label: "coverage", value: "coverage ", description: "Show enforcement coverage" },
  { label: "onboard", value: "onboard ", description: "Discover and compile project policy" },
  { label: "link", value: "link @", description: "Add a persistent file or directory source" },
  { label: "review", value: "review ", description: "Review compiled policy rules" },
  { label: "audit", value: "audit ", description: "Inspect recent redacted decision traces" },
  {
    label: "maintenance",
    value: "maintenance ",
    description: "Review or approve one exact maintenance retry",
  },
  { label: "consent", value: "consent ", description: "Enable or disable remote evaluation" },
];

const CONSENT_ARGUMENTS: readonly PolicyCommandCompletion[] = [
  { label: "on", value: "consent on", description: "Enable remote semantic evaluation" },
  { label: "off", value: "consent off", description: "Disable remote semantic evaluation" },
];

const MAINTENANCE_ARGUMENTS: readonly PolicyCommandCompletion[] = [
  {
    label: "approve",
    value: "maintenance approve ",
    description: "Approve the displayed action ID once",
  },
  {
    label: "revoke",
    value: "maintenance revoke",
    description: "Discard pending maintenance authorization",
  },
];

export function getPolicyArgumentCompletions(
  argumentPrefix: string,
): PolicyCommandCompletion[] | null {
  const normalized = argumentPrefix.toLowerCase();
  const firstSpace = normalized.indexOf(" ");
  if (firstSpace === -1) {
    const matches = POLICY_SUBCOMMANDS.filter((item) => item.label.startsWith(normalized));
    return matches.length === 0 ? null : matches;
  }

  const command = normalized.slice(0, firstSpace);
  const valuePrefix = normalized.slice(firstSpace + 1);
  if (valuePrefix.includes(" ")) {
    return null;
  }
  const argumentsForCommand =
    command === "consent"
      ? CONSENT_ARGUMENTS
      : command === "maintenance"
        ? MAINTENANCE_ARGUMENTS
        : [];
  const matches = argumentsForCommand.filter((item) => item.label.startsWith(valuePrefix));
  return matches.length === 0 ? null : matches;
}

/** Accept OMP's argument-only form and a defensive full-command form. */
export function parsePolicyCommandArguments(args: string): PolicyCommandInvocation {
  const input = args.trim().replace(/^\/?policy(?:\s+|$)/iu, "");
  if (input.length === 0) {
    return { command: "status" };
  }

  const separator = input.search(/\s/u);
  const rawCommand = separator === -1 ? input : input.slice(0, separator);
  const command = rawCommand.toLowerCase();
  const remainder = separator === -1 ? "" : input.slice(separator).trim();
  if (command === "link") {
    const path = remainder.startsWith("@") ? remainder.slice(1).trim() : "";
    return path.length === 0 ? { command: "invalid" } : { command, path };
  }

  const tokens = remainder.length === 0 ? [] : remainder.split(/\s+/u);
  const value = tokens[0]?.toLowerCase();
  const actionId = tokens[1];
  if (
    tokens.length > 2 ||
    (actionId !== undefined && (command !== "maintenance" || value !== "approve"))
  ) {
    return { command: "invalid" };
  }
  return {
    command,
    ...(value === undefined ? {} : { value }),
    ...(actionId === undefined ? {} : { actionId }),
  };
}
