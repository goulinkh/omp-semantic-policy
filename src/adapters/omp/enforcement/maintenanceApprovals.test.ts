import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { compilePolicySnapshot } from "../../../policy/index.js";
import { normalizeOmpToolCall } from "../events/normalizeToolCall.js";
import { createMaintenanceApprovals } from "./maintenanceApprovals.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "policy-maintenance-"));
  fixtures.push(temporary);
  const root = await realpath(temporary);
  await mkdir(join(root, "plugin"));
  const snapshot = compilePolicySnapshot({
    projectRoot: root,
    sources: [],
    versions: { question: "fixture", thresholds: "fixture", model: "fixture" },
  });
  const proposal = (id: string, input: Record<string, unknown>) =>
    normalizeOmpToolCall(
      {
        type: "tool_call",
        toolCallId: id,
        toolName: "write",
        input,
      } as ToolCallEvent,
      { cwd: root, sessionManager: { getSessionId: () => "session" } },
    );
  return { root, snapshot, proposal };
}

describe("maintenance authorization boundary", () => {
  test("distinguishes changed content even when credential redaction would look identical", async () => {
    const { snapshot, proposal } = await fixture();
    const approvals = createMaintenanceApprovals();
    const original = proposal("original", {
      path: "plugin/omp-plugins.lock.json",
      content: '{"token":"fixture-alpha"}',
    });
    const altered = proposal("altered", {
      path: "plugin/omp-plugins.lock.json",
      content: '{"token":"fixture-beta"}',
    });
    await approvals.remember(original, snapshot);
    expect(approvals.approve("original", snapshot, "session")).toBe(true);
    expect(await approvals.consume(altered, snapshot)).toBe(false);
    expect(await approvals.consume({ ...original, id: "retry" }, snapshot)).toBe(true);
    expect(await approvals.consume(original, snapshot)).toBe(false);
  });

  test("rejects a lockfile replaced by an escaping symlink after approval", async () => {
    const { root, snapshot, proposal } = await fixture();
    const target = join(root, "plugin", "omp-plugins.lock.json");
    await writeFile(target, "{}");
    const action = proposal("original", { path: target, content: "{}" });
    const approvals = createMaintenanceApprovals();
    await approvals.remember(action, snapshot);
    expect(approvals.approve("original", snapshot, "session")).toBe(true);
    await rm(target);
    await symlink(join(root, "unapproved.json"), target);
    expect(await approvals.consume(action, snapshot)).toBe(false);
  });
});
