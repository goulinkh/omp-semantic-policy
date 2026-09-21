import { describe, expect, test } from "bun:test";
import { getPolicyArgumentCompletions, parsePolicyCommandArguments } from "./policyCommand.js";

describe("policy command", () => {
  test("filters subcommands and completes consent values", () => {
    expect(getPolicyArgumentCompletions("on")?.map((item) => item.label)).toEqual(["onboard"]);
    expect(getPolicyArgumentCompletions("li")?.map((item) => item.label)).toEqual(["link"]);
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
    expect(parsePolicyCommandArguments("/policy link @../../Code Standards")).toEqual({
      command: "link",
      path: "../../Code Standards",
    });
    expect(parsePolicyCommandArguments("link ../../code-standards").command).toBe("invalid");
  });

  test("preserves case-sensitive action IDs and rejects trailing approval arguments", () => {
    expect(parsePolicyCommandArguments("/policy maintenance approve Tool-AbC")).toEqual({
      command: "maintenance",
      value: "approve",
      actionId: "Tool-AbC",
    });
    expect(parsePolicyCommandArguments("maintenance approve Tool-AbC extra").command).toBe(
      "invalid",
    );
    expect(parsePolicyCommandArguments("consent on extra").command).toBe("invalid");
  });
});
