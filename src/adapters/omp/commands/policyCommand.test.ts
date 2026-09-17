import { describe, expect, test } from "bun:test";
import { getPolicyArgumentCompletions, parsePolicyCommandArguments } from "./policyCommand.js";

describe("policy command", () => {
  test("offers every subcommand after /policy", () => {
    expect(getPolicyArgumentCompletions("")?.map((item) => item.label)).toEqual([
      "status",
      "coverage",
      "onboard",
      "review",
      "consent",
    ]);
  });

  test("filters subcommands and completes consent values", () => {
    expect(getPolicyArgumentCompletions("on")?.map((item) => item.label)).toEqual(["onboard"]);
    expect(getPolicyArgumentCompletions("consent ")?.map((item) => item.value)).toEqual([
      "consent on",
      "consent off",
    ]);
    expect(getPolicyArgumentCompletions("review ")).toBeNull();
  });

  test("parses both OMP arguments and defensive full-command input", () => {
    expect(parsePolicyCommandArguments("onboard")).toEqual({ command: "onboard" });
    expect(parsePolicyCommandArguments("/policy onboard")).toEqual({ command: "onboard" });
    expect(parsePolicyCommandArguments("policy onboard")).toEqual({ command: "onboard" });
    expect(parsePolicyCommandArguments(" CONSENT ON ")).toEqual({
      command: "consent",
      value: "on",
    });
    expect(parsePolicyCommandArguments("")).toEqual({ command: "status" });
  });
});
