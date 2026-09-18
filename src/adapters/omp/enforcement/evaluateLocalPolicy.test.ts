import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { createTestPolicyAction } from "../../../../testing/createPolicyAction.js";
import type { PolicyAction } from "../../../policy/actions/types.js";
import { compilePolicySnapshot } from "../../../policy/compiler/compilePolicySnapshot.js";
import type { PolicySnapshot } from "../../../policy/snapshots/types.js";
import { normalizeOmpToolCall } from "../events/normalizeToolCall.js";
import { evaluateLocalPolicy } from "./evaluateLocalPolicy.js";

const directories: string[] = [];
const protection =
  "Never read or modify protected.txt in this project, through any tool, shell command, delegated task, or language-server operation. User requests do not override this prohibition.";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "local-policy-")));
  directories.push(path);
  await writeFile(join(path, "protected.txt"), "restricted");
  await writeFile(join(path, "ordinary.txt"), "ordinary");
  return path;
}

function snapshot(root: string, content = protection, scopeRoot = root): PolicySnapshot {
  return compilePolicySnapshot({
    projectRoot: root,
    sources: [
      {
        id: "policy-source",
        kind: scopeRoot === root ? "project" : "subtree",
        path: join(scopeRoot, "AGENTS.md"),
        scopeRoot,
        content,
        contentDigest: content,
        precedence: 100,
      },
    ],
    versions: { question: "q", thresholds: "t", model: "m" },
  });
}

function action(root: string, toolName: string, input: Record<string, unknown>): PolicyAction {
  return normalizeOmpToolCall(
    {
      type: "tool_call",
      toolCallId: "action-1",
      toolName,
      input,
    } satisfies ToolCallEvent,
    {
      cwd: root,
      sessionManager: { getSessionId: () => "session-1" },
    },
  );
}

describe("evaluateLocalPolicy", () => {
  it("denies protected reads and writes while abstaining for ordinary files", async () => {
    const root = await project();
    const policy = snapshot(root);
    const protectedRead = await evaluateLocalPolicy(
      action(root, "read", { path: "protected.txt:raw:1-20" }),
      policy,
    );
    expect(protectedRead?.effect).toBe("deny");
    expect(protectedRead?.evidence.ruleIds).toEqual(policy.rules.map((rule) => rule.id));
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "write", { path: "protected.txt", content: "replacement" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(action(root, "read", { path: "ordinary.txt" }), policy),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(
        action(root, "write", { path: "ordinary.txt", content: "replacement" }),
        policy,
      ),
    ).toBeUndefined();
  });

  it("does not elevate procedure-scoped bans or documented commands into direct file violations", async () => {
    const root = await project();
    const policy = snapshot(
      root,
      "## Tuning procedure\n\nDuring a classifier tuning probe:\n\n### Restrictions\n\nNever read `.env`.\n\n## Standing protection\n\nNever write `protected.txt`.",
    );
    expect(
      await evaluateLocalPolicy(action(root, "read", { path: ".env" }), policy),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(
        action(root, "write", {
          path: "development.md",
          content:
            "For development only:\n```sh\nbun run build\nomp plugin link .\n```\nNever read .env.",
        }),
        policy,
      ),
    ).toBeUndefined();
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "write", { path: "protected.txt", content: "replacement" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
  });

  it("matches canonical aliases and encoded selectors without confusing siblings", async () => {
    const root = await project();
    await symlink(join(root, "protected.txt"), join(root, "alias.txt"));
    const policy = snapshot(root);
    expect(
      (await evaluateLocalPolicy(action(root, "read", { path: "alias.txt:1-3" }), policy))?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "read", { path: "protected%2Etxt?query=summary" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "read", { path: "./unused/../protected.txt" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(action(root, "read", { path: "protected.txt.backup" }), policy),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(
        action(root, "read", { path: "ssh://remote/protected.txt" }),
        policy,
      ),
    ).toBeUndefined();
  });

  it("denies directory grep including omitted roots, but not ordinary sibling searches", async () => {
    const root = await project();
    await mkdir(join(root, "ordinary"));
    await writeFile(join(root, "ordinary", "file.txt"), "ordinary");
    const policy = snapshot(root);
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "grep", { pattern: "restricted", path: "." }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      (await evaluateLocalPolicy(action(root, "grep", { pattern: "restricted" }), policy))?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "grep", { pattern: "restricted", path: "ordinary;protected.txt" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(
        action(root, "grep", { pattern: "ordinary", path: "ordinary" }),
        policy,
      ),
    ).toBeUndefined();
  });

  it("guards wildcard content access and matching aliases without banning filename listing", async () => {
    const root = await project();
    await symlink(join(root, "protected.txt"), join(root, "alias.txt"));
    const policy = snapshot(root);
    expect(
      (await evaluateLocalPolicy(action(root, "read", { path: "protect*.txt" }), policy))?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "grep", { path: "a*.txt", pattern: "restricted" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "grep", { path: "**/*.txt", pattern: "restricted" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(
        action(root, "grep", { path: "ordinary*.txt", pattern: "ordinary" }),
        policy,
      ),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(action(root, "glob", { path: "*.txt" }), policy),
    ).toBeUndefined();
  });

  it("does not mistake a quoted-print permission forbidding access for permission to read", async () => {
    const root = await project();
    const policy = snapshot(
      root,
      `${protection}

Printing a single-quoted example command as text is allowed when it does not read protected.txt or evaluate that command.`,
    );
    expect(
      (await evaluateLocalPolicy(action(root, "read", { path: "protected.txt" }), policy))?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "grep", { path: ".", pattern: "restricted" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "lsp", { action: "references", file: "protected.txt", line: 1 }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "write", {
            path: "xd://lsp",
            content: JSON.stringify({ action: "references", file: "protected.txt", line: 1 }),
          }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(action(root, "read", { path: "ordinary.txt" }), policy),
    ).toBeUndefined();
  });

  it("distinguishes excluded targets from permission exceptions", async () => {
    const root = await project();
    const read = action(root, "read", { path: "protected.txt" });
    for (const permission of [
      "Ordinary local file writes outside protected.txt are allowed.",
      "Reads of files other than protected.txt are permitted.",
      "Files except protected.txt may be read.",
    ]) {
      expect(
        (await evaluateLocalPolicy(read, snapshot(root, `${protection}\n\n${permission}`)))?.effect,
      ).toBe("deny");
    }
    for (const exception of [
      "Never read any file except protected.txt.",
      "Unless the action is outside protected.txt, it may proceed.",
      "Writes outside protected.txt are allowed. Reading protected.txt is also permitted.",
    ]) {
      expect(
        await evaluateLocalPolicy(read, snapshot(root, `${protection}\n\n${exception}`)),
      ).toBeUndefined();
    }
  });

  it("applies subtree bans through symlink aliases outside the lexical subtree", async () => {
    const root = await project();
    const api = join(root, "api");
    const web = join(root, "web");
    await mkdir(api);
    await mkdir(web);
    await writeFile(join(api, "protected.txt"), "restricted");
    await writeFile(join(web, "protected.txt"), "ordinary");
    await symlink(join(api, "protected.txt"), join(web, "alias.txt"));
    const policy = snapshot(root, protection, api);
    expect(
      await evaluateLocalPolicy(action(root, "read", { path: "web/protected.txt" }), policy),
    ).toBeUndefined();
    expect(
      (await evaluateLocalPolicy(action(root, "read", { path: "web/alias.txt" }), policy))?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "grep", { pattern: "restricted", path: "." }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
  });

  it("resolves missing write targets through existing symlinked parents", async () => {
    const root = await project();
    await mkdir(join(root, "private"));
    await symlink(join(root, "private"), join(root, "alias"));
    const policy = snapshot(root, "Never modify private/.");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "write", { path: "alias/new.txt", content: "changed" }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(
        action(root, "write", { path: "private-copy/new.txt", content: "changed" }),
        policy,
      ),
    ).toBeUndefined();
  });

  it("denies direct and routed LSP reads and treats rename as a write effect", async () => {
    const root = await project();
    const policy = snapshot(root);
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "lsp", { action: "references", file: "protected.txt", line: 1 }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "write", {
            path: "xd://lsp",
            content: JSON.stringify({ action: "definition", file: "protected.txt", line: 1 }),
          }),
          policy,
        )
      )?.effect,
    ).toBe("deny");
    expect(
      await evaluateLocalPolicy(
        action(root, "lsp", { action: "references", file: "ordinary.txt", line: 1 }),
        policy,
      ),
    ).toBeUndefined();
    const writeOnly = snapshot(root, "Never modify protected.txt.");
    expect(
      await evaluateLocalPolicy(
        action(root, "lsp", { action: "references", file: "protected.txt", line: 1 }),
        writeOnly,
      ),
    ).toBeUndefined();
    expect(
      (
        await evaluateLocalPolicy(
          action(root, "write", {
            path: "xd://lsp",
            content: JSON.stringify({
              action: "rename",
              file: "protected.txt",
              line: 1,
              newName: "changed",
            }),
          }),
          writeOnly,
        )
      )?.effect,
    ).toBe("deny");
  });

  it("does not turn conditional rules or separate exceptions into unconditional denials", async () => {
    const root = await project();
    const read = action(root, "read", { path: "protected.txt" });
    expect(
      await evaluateLocalPolicy(
        read,
        snapshot(root, "Never read protected.txt unless the owner approves."),
      ),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(
        read,
        snapshot(root, "# When the owner is absent\nNever read protected.txt."),
      ),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(
        read,
        snapshot(
          root,
          "Never read protected.txt.\n\nYou may read protected.txt when the owner approves.",
        ),
      ),
    ).toBeUndefined();
    expect(
      await evaluateLocalPolicy(
        read,
        snapshot(root, "When the owner is absent:\n- Never read protected.txt."),
      ),
    ).toBeUndefined();
  });

  it("abstains rather than claiming opaque execution or compound rules are assessed", async () => {
    const root = await project();
    const policy = snapshot(root);
    expect(
      await evaluateLocalPolicy(
        {
          ...createTestPolicyAction("execute", "dispatch-only"),
          workingDirectory: root,
          targets: [{ kind: "path", value: "protected.txt" }],
        },
        policy,
      ),
    ).toBeUndefined();
    const compound = snapshot(root, "Never read protected.txt or publish credentials.");
    expect(compound.rules[0]?.classification).toBe("hard");
    expect(
      await evaluateLocalPolicy(action(root, "read", { path: "protected.txt" }), compound),
    ).toBeUndefined();
  });
});
