export interface PolicyCommandCompletion {
  readonly label: string;
  readonly value: string;
  readonly description: string;
}

export interface PolicyCommandInvocation {
  readonly command: string;
  readonly value?: string;
  readonly actionId?: string;
}

const POLICY_SUBCOMMANDS: readonly PolicyCommandCompletion[] = [
  { label: "status", value: "status ", description: "Show the active project policy" },
  { label: "coverage", value: "coverage ", description: "Show enforcement coverage" },
  { label: "onboard", value: "onboard ", description: "Discover and compile project policy" },
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
  const tokens = args
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  const first = tokens[0]?.toLowerCase();
  if (first === "policy" || first === "/policy") {
    tokens.shift();
  }

  const command = tokens[0]?.toLowerCase() ?? "status";
  const value = tokens[1]?.toLowerCase();
  const actionId = tokens[2];
  if (
    tokens.length > 3 ||
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
