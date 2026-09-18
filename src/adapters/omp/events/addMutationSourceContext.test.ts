import { afterEach, describe, expect, it } from "bun:test";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyAction } from "../../../policy/actions/types.js";
import { compilePolicySnapshot } from "../../../policy/compiler/compilePolicySnapshot.js";
import type { PolicySnapshot } from "../../../policy/snapshots/types.js";
import { createRedactedProviderState } from "../../typesafe/redactProviderState.js";
import { addMutationSourceContext } from "./addMutationSourceContext.js";
import { normalizeOmpToolCall } from "./normalizeToolCall.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mutation-context-")));
  directories.push(root);
  return root;
}

function snapshot(root: string, content = "Keep application behavior consistent."): PolicySnapshot {
  return compilePolicySnapshot({
    projectRoot: root,
    sources: [
      {
        id: "policy",
        kind: "project",
        path: join(root, "AGENTS.md"),
        scopeRoot: root,
        content,
        contentDigest: content,
        precedence: 100,
      },
    ],
    versions: { question: "q", thresholds: "t", model: "m" },
  });
}

function action(root: string, name: string, input: Record<string, unknown>): PolicyAction {
  return normalizeOmpToolCall(
    { type: "tool_call", toolCallId: "mutation", toolName: name, input },
    { cwd: root, sessionManager: { getSessionId: () => "session" } },
  );
}

async function evidence(
  root: string,
  input: Record<string, unknown>,
  name = "edit",
  policy = snapshot(root),
) {
  const enriched = await addMutationSourceContext(action(root, name, input), policy);
  return createRedactedProviderState({ action: enriched, snapshot: policy }).action;
}

// Consumer-side shape: tests inspect the serialized provider boundary, not helper internals.
type Context = {
  phase: string;
  files: {
    path: string;
    status: string;
    ranges?: { startLine: number; endLine: number; text: string }[];
    reason?: string;
  }[];
};

function source(value: { details: Record<string, unknown> }): Context {
  return value.details.sourceContext as Context;
}

type Mutations = {
  phase: "proposed";
  files: {
    path: string;
    status: "included" | "partial" | "unavailable";
    hunks?: {
      before: { startLine: number; lineCount: number; text: string };
      after: { startLine: number; lineCount: number; text: string };
    }[];
    reason?: string;
  }[];
};

function mutations(value: { details: Record<string, unknown> }): Mutations {
  return value.details.mutationContext as Mutations;
}

function hashlineInput(original: string, operations: string, path = "module.txt") {
  const normalized = original.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  return {
    input: `*** Begin Patch\n[${path}#${hashlineFileHash(normalized)}]\n${operations}\n*** End Patch`,
  };
}

describe("pre-mutation source evidence", () => {
  it("rereads small original files and preserves the proposed mutation", async () => {
    const root = await project();
    const input = { path: "module.txt", old_string: "previous", new_string: "replacement" };
    await writeFile(join(root, "module.txt"), "previous\r\nneighbor\r\n");
    const first = await evidence(root, input);
    expect(source(first).files[0]).toEqual({
      path: "module.txt",
      status: "included",
      ranges: [{ startLine: 1, endLine: 2, text: "previous\r\nneighbor\r\n" }],
    });
    await writeFile(join(root, "module.txt"), "changed\nother neighbor");
    const second = await evidence(root, input);
    expect(source(second).files[0]?.ranges?.[0]?.text).toBe("changed\nother neighbor");
    expect(first.details.old_string).toBe("previous");
    expect(second.details.new_string).toBe("replacement");
    expect(second.complete).toBe(true);
  });

  it("retains exact original anchored lines with bounded neighboring code", async () => {
    const root = await project();
    const lines = Array.from(
      { length: 900 },
      (_, index) => `const value${index + 1} = ${index + 1};\n`,
    );
    await writeFile(join(root, "module.txt"), lines.join(""));
    const state = await evidence(root, {
      input: "*** Begin Patch\n[module.txt#A1B2]\nPUT 450.=452:\n+replacement\n*** End Patch",
    });
    expect(source(state).files[0]).toMatchObject({
      status: "partial",
      ranges: [{ startLine: 447, endLine: 455, text: lines.slice(446, 455).join("") }],
    });
    expect(JSON.stringify(source(state))).not.toContain("replacement");
    expect(state.complete).toBe(true);
  });

  it.each([
    {
      name: "replacement",
      input: { path: "module.txt", old_string: "const value450 = 450;", new_string: "replacement" },
    },
    {
      name: "batched replacement",
      input: {
        path: "module.txt",
        edits: [{ old_string: "const value450 = 450;", new_string: "replacement" }],
      },
    },
    {
      name: "coordinate diff",
      input: {
        path: "module.txt",
        edits: [{ diff: "@@ -450,1 +450,1 @@\n-const value450 = 450;\n+replacement" }],
      },
    },
    {
      name: "context diff",
      input: {
        input:
          "*** Begin Patch\n*** Update File: module.txt\n@@\n-const value450 = 450;\n+replacement\n*** End Patch",
      },
    },
  ])("locates original source for $name without executing the edit", async ({ input }) => {
    const root = await project();
    const lines = Array.from(
      { length: 900 },
      (_, index) => `const value${index + 1} = ${index + 1};\n`,
    );
    await writeFile(join(root, "module.txt"), lines.join(""));
    const state = await evidence(root, input);
    expect(source(state).files[0]).toMatchObject({
      status: "partial",
      ranges: [{ startLine: 447, endLine: 453, text: lines.slice(446, 453).join("") }],
    });
  });

  it("keeps coordinates scoped to their patch section and inspects move destinations", async () => {
    const root = await project();
    const lines = Array.from({ length: 900 }, (_, index) => `original line ${index + 1}\n`);
    await writeFile(join(root, "first.txt"), lines.join(""));
    await writeFile(join(root, "second.txt"), lines.join(""));
    await writeFile(join(root, "destination.txt"), "existing destination");
    const state = await evidence(root, {
      input:
        "*** Begin Patch\n[first.txt#A1B2]\nCUT 100.=100\nMV destination.txt\n[second.txt#C3D4]\nCUT 700.=700\n*** End Patch",
    });
    const files = source(state).files;
    expect(files.find((file) => file.path === "first.txt")?.ranges).toEqual([
      { startLine: 97, endLine: 103, text: lines.slice(96, 103).join("") },
    ]);
    expect(files.find((file) => file.path === "second.txt")?.ranges).toEqual([
      { startLine: 697, endLine: 703, text: lines.slice(696, 703).join("") },
    ]);
    expect(files.find((file) => file.path === "destination.txt")?.ranges?.[0]?.text).toBe(
      "existing destination",
    );
  });

  it("does not confuse absent files with explicit empty originals", async () => {
    const root = await project();
    await writeFile(join(root, "empty.txt"), "");
    const empty = source(
      await evidence(root, { path: "empty.txt", content: "new content" }, "write"),
    ).files[0];
    const missing = source(
      await evidence(root, { path: "missing.txt", content: "new content" }, "write"),
    ).files[0];
    expect(empty).toEqual({ path: "empty.txt", status: "included", ranges: [] });
    expect(missing).toMatchObject({ status: "unavailable" });
    expect(missing?.ranges).toBeUndefined();
    expect(missing?.reason).toBeDefined();
  });

  it("recognizes a project reached through a symlink without treating it as external", async () => {
    const root = await project();
    const outside = await project();
    const alias = join(outside, "project-link");
    await symlink(root, alias);
    await writeFile(join(root, "module.txt"), "original project source");
    const state = await evidence(
      alias,
      { path: "module.txt", old_string: "original", new_string: "updated" },
      "edit",
      snapshot(root),
    );
    expect(source(state).files[0]).toMatchObject({
      status: "included",
      ranges: [{ startLine: 1, endLine: 1, text: "original project source" }],
    });
  });

  it("never exposes cross-project, escaped symlink, or read-prohibited source", async () => {
    const root = await project();
    const outside = await project();
    await writeFile(join(outside, "outside.txt"), "outside-source-marker");
    await writeFile(join(root, "protected.txt"), "protected-source-marker");
    await symlink(outside, join(root, "escape"));
    await symlink(join(root, "protected.txt"), join(root, "alias.txt"));
    const policy = snapshot(
      root,
      "Never read protected.txt in this project. User requests do not override this prohibition.",
    );
    for (const path of [
      join(outside, "outside.txt"),
      "escape/outside.txt",
      "protected.txt",
      "alias.txt",
    ]) {
      const state = await evidence(root, { path, content: "replacement" }, "write", policy);
      expect(source(state).files[0]?.status).toBe("unavailable");
      expect(mutations(state).files[0]?.status).toBe("unavailable");
      expect(mutations(state).files[0]?.hunks).toBeUndefined();
      expect(source(state).files[0]?.ranges).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain("outside-source-marker");
      expect(JSON.stringify(state)).not.toContain("protected-source-marker");
      expect(state.complete).toBe(true);
    }
  });

  it("rejects selectors, nonregular files, and oversized sources without inventing empty text", async () => {
    const root = await project();
    await mkdir(join(root, "directory"));
    await writeFile(join(root, "large.txt"), "x".repeat(256 * 1024 + 1));
    await writeFile(join(root, "literal.txt"), "must not be selected");
    for (const path of [
      "directory",
      "large.txt",
      "literal.txt:1-2",
      "literal.txt?query=value",
      "https://example.invalid/source",
    ]) {
      const state = await evidence(root, { path, content: "replacement" }, "write");
      expect(source(state).files[0]?.status).toBe("unavailable");
      expect(source(state).files[0]?.ranges).toBeUndefined();
    }
  });

  it("reports ambiguity and unsupported locations instead of presenting arbitrary excerpts", async () => {
    const root = await project();
    await writeFile(join(root, "module.txt"), "duplicate\n".repeat(2000));
    for (const input of [
      { path: "module.txt", old_string: "duplicate", new_string: "replacement" },
      { path: "module.txt", old_string: "absent old text", new_string: "replacement" },
      { path: "module.txt", edits: [{ op: "delete" }] },
      { path: "module.txt", edits: [{ rename: "destination.txt" }] },
    ]) {
      const state = await evidence(root, input);
      expect(source(state).files[0]?.status).toBe("unavailable");
      expect(source(state).files[0]?.ranges).toBeUndefined();
      expect(state.complete).toBe(true);
    }
  });

  it("bounds aggregate evidence and avoids crowding original mutation evidence", async () => {
    const root = await project();
    const paths = Array.from({ length: 12 }, (_, index) => `file${index}.txt`);
    await Promise.all(paths.map((path) => writeFile(join(root, path), "source row\n".repeat(600))));
    const patch = `*** Begin Patch\n${paths.map((path) => `[${path}#A1B2]\nPUT 200.=200:\n+replacement`).join("\n")}\n*** End Patch`;
    const state = await evidence(root, { input: patch });
    expect(
      Buffer.byteLength(
        JSON.stringify({
          sourceContext: state.details.sourceContext,
          mutationContext: state.details.mutationContext,
        }),
      ),
    ).toBeLessThanOrEqual(8192);
    expect(source(state).files.length).toBeLessThanOrEqual(8);
    expect(state.complete).toBe(true);
    expect(state.details.input).toBe(patch);
    const content = "replacement".repeat(2800);
    const nearLimit = await evidence(root, { path: paths[0], content }, "write");
    expect(nearLimit.details.content).toBe(content);
    expect(nearLimit.complete).toBe(true);
  });

  it("redacts recognized source credentials at the provider boundary", async () => {
    const root = await project();
    await writeFile(join(root, "module.txt"), "TOKEN=private-source-token\nordinary=value\n");
    const state = await evidence(root, { path: "module.txt", content: "replacement" }, "write");
    expect(JSON.stringify(source(state))).not.toContain("private-source-token");
    expect(JSON.stringify(source(state))).toContain("ordinary=value");
    expect(JSON.stringify(source(state))).toContain("REDACTED");
    expect(JSON.stringify(mutations(state))).not.toContain("private-source-token");
    expect(JSON.stringify(mutations(state))).toContain("REDACTED");
  });

  it("does not enrich routed or custom tools and propagates cancellation", async () => {
    const root = await project();
    const policy = snapshot(root);
    const routed = action(root, "write", {
      path: "xd://debug",
      content: '{"action":"evaluate","expression":"1"}',
    });
    expect(await addMutationSourceContext(routed, policy)).toBe(routed);
    const native = action(root, "write", { path: "module.txt", content: "replacement" });
    const custom = {
      ...native,
      hostAction: { ...native.hostAction, source: { kind: "extension", path: "extension.ts" } },
    };
    expect(await addMutationSourceContext(custom, policy)).toBe(custom);
    const controller = new AbortController();
    controller.abort(new Error("cancelled source inspection"));
    await expect(addMutationSourceContext(native, policy, controller.signal)).rejects.toThrow(
      "cancelled source inspection",
    );
  });
});

describe("explicit proposed mutation evidence", () => {
  it("distinguishes removals from additions and tracks simultaneous original-coordinate shifts", async () => {
    const root = await project();
    const original = "one\nremove\nthree\nfour\nfive\nsix\n";
    const input = hashlineInput(original, "PUT 6.=6:\n+done\nCUT 2.=2\nPUT <4:\n+added\n+second");
    await writeFile(join(root, "module.txt"), original);
    const state = await evidence(root, input);
    expect(mutations(state)).toEqual({
      phase: "proposed",
      files: [
        {
          path: "module.txt",
          status: "included",
          hunks: [
            {
              before: { startLine: 2, lineCount: 1, text: "remove\n" },
              after: { startLine: 2, lineCount: 0, text: "" },
            },
            {
              before: { startLine: 4, lineCount: 0, text: "" },
              after: { startLine: 3, lineCount: 2, text: "added\nsecond\n" },
            },
            {
              before: { startLine: 6, lineCount: 1, text: "six\n" },
              after: { startLine: 7, lineCount: 1, text: "done\n" },
            },
          ],
        },
      ],
    });
    expect(state.details.input).toBe(input.input);
    expect(await readFile(join(root, "module.txt"), "utf8")).toBe(original);
  });

  it("preserves BOM, CRLF, and an unterminated final line in numeric replacements", async () => {
    const root = await project();
    const original = "\uFEFFfirst\r\nmiddle\r\nlast";
    await writeFile(join(root, "module.txt"), original);
    const state = await evidence(
      root,
      hashlineInput(original, "PUT 2.=3:\n+new middle\n+new last"),
    );
    expect(mutations(state).files[0]).toMatchObject({
      status: "included",
      hunks: [
        {
          before: { startLine: 2, lineCount: 2, text: "middle\r\nlast" },
          after: { startLine: 2, lineCount: 2, text: "new middle\r\nnew last" },
        },
      ],
    });
    expect(source(state).files[0]?.ranges?.[0]?.text).toBe(original);
    expect(await readFile(join(root, "module.txt"), "utf8")).toBe(original);
  });

  it("uses native EOF and anchored gap semantics without synthetic final newlines", async () => {
    const root = await project();
    await writeFile(join(root, "module.txt"), "first\nlast\n");
    const inserted = await evidence(
      root,
      hashlineInput("first\nlast\n", "PUT >1:\n+middle\nPUT >$:\n+tail"),
    );
    expect(mutations(inserted).files[0]?.hunks).toEqual([
      {
        before: { startLine: 2, lineCount: 0, text: "" },
        after: { startLine: 2, lineCount: 1, text: "middle\n" },
      },
      {
        before: { startLine: 3, lineCount: 0, text: "" },
        after: { startLine: 4, lineCount: 1, text: "tail\n" },
      },
    ]);
    await writeFile(join(root, "module.txt"), "");
    const empty = await evidence(root, hashlineInput("", "PUT >$:\n+first"));
    expect(mutations(empty).files[0]?.hunks).toEqual([
      {
        before: { startLine: 1, lineCount: 0, text: "" },
        after: { startLine: 1, lineCount: 1, text: "first" },
      },
    ]);
    await writeFile(join(root, "module.txt"), "old\n");
    const replaced = await evidence(root, hashlineInput("old\n", "CUT 1.=1\nPUT >$:\n+new"));
    expect(mutations(replaced).files[0]?.hunks?.[0]?.after.text).toBe("new");
  });

  it("models sequential exact replacement batches and explicit replace_all without fuzzy matching", async () => {
    const root = await project();
    const original = "first\r\nkeep\r\nlast";
    await writeFile(join(root, "module.txt"), original);
    const state = await evidence(root, {
      path: "module.txt",
      edits: [
        { old_string: "first", new_string: "interim\nextra" },
        { old_string: "interim", new_string: "final" },
      ],
    });
    expect(mutations(state).files[0]?.hunks).toEqual([
      {
        before: { startLine: 1, lineCount: 1, text: "first\r\n" },
        after: { startLine: 1, lineCount: 2, text: "final\r\nextra\r\n" },
      },
    ]);
    await writeFile(join(root, "module.txt"), "same\nsame\n");
    const ambiguous = await evidence(root, {
      path: "module.txt",
      old_string: "same",
      new_string: "new",
    });
    expect(mutations(ambiguous).files[0]).toMatchObject({ status: "unavailable" });
    expect(mutations(ambiguous).files[0]?.hunks).toBeUndefined();
    const all = await evidence(root, {
      path: "module.txt",
      old_string: "same",
      new_string: "new",
      replace_all: true,
    });
    expect(mutations(all).files[0]?.hunks?.[0]?.after.text).toBe("new\nnew\n");
  });

  it("derives exact unified patches in native coordinates and preserves character-mode deletions", async () => {
    const root = await project();
    const original = "one\ntwo\nthree\n";
    await writeFile(join(root, "module.txt"), original);
    const state = await evidence(root, {
      path: "module.txt",
      edits: [{ diff: "@@ -2,0 +2,1 @@\n+inserted\n@@ -3,1 +4,1 @@\n-three\n+last" }],
    });
    expect(mutations(state).files[0]?.hunks).toEqual([
      {
        before: { startLine: 2, lineCount: 0, text: "" },
        after: { startLine: 2, lineCount: 1, text: "inserted\n" },
      },
      {
        before: { startLine: 3, lineCount: 1, text: "three\n" },
        after: { startLine: 4, lineCount: 1, text: "last\n" },
      },
    ]);
    const removed = await evidence(root, {
      input: "*** Begin Patch\n*** Update File: module.txt\n@@\n-two\n*** End Patch",
    });
    expect(mutations(removed).files[0]?.hunks).toEqual([
      {
        before: { startLine: 2, lineCount: 1, text: "two\n" },
        after: { startLine: 2, lineCount: 1, text: "\n" },
      },
    ]);
    const mismatch = await evidence(root, {
      path: "module.txt",
      edits: [{ diff: "@@ -2,1 +2,1 @@\n-not two\n+last" }],
    });
    expect(mutations(mismatch).files[0]?.status).toBe("unavailable");
    expect(await readFile(join(root, "module.txt"), "utf8")).toBe(original);
  });

  it("rejects stale snapshots, overlapping ranges, and host-dependent selectors without discarding raw input", async () => {
    const root = await project();
    const original = "one\ntwo\nthree\n";
    await writeFile(join(root, "module.txt"), original);
    const inputs = [
      hashlineInput("different\n", "CUT 1.=1"),
      ...[
        "PUT 1.=2:\n+new\nCUT 2.=3",
        "PUT 1*:\n+new",
        "CUT 1.=1 @saved",
        "PUT >1 @saved",
        "MV other.txt",
        "REM",
        "PUT 9.=9:\n+new",
      ].map((operation) => hashlineInput(original, operation)),
    ];
    for (const input of inputs) {
      const state = await evidence(root, input);
      expect(mutations(state).files[0]?.status).toBe("unavailable");
      expect(mutations(state).files[0]?.hunks).toBeUndefined();
      expect(state.details.input).toBe(input.input);
    }
    expect(await readFile(join(root, "module.txt"), "utf8")).toBe(original);
  });

  it("does not invent after-state for native boundary repair or copied display prefixes", async () => {
    const root = await project();
    const original = "neighbor\none\ntwo\ntail\n";
    await writeFile(join(root, "module.txt"), original);
    const echo = await evidence(
      root,
      hashlineInput(original, "PUT 2.=3:\n+neighbor\n+new one\n+new two"),
    );
    expect(mutations(echo).files[0]?.status).toBe("unavailable");
    const copied = await evidence(
      root,
      { path: "module.txt", content: "[module.txt#ABCD]\n1:copied\n" },
      "write",
    );
    expect(mutations(copied).files[0]?.status).toBe("unavailable");
  });

  it("distinguishes existing empty files from missing files and remains independent of completeness", async () => {
    const root = await project();
    await writeFile(join(root, "empty.txt"), "");
    const initial = action(root, "write", { path: "empty.txt", content: "new\r\n" });
    const enriched = await addMutationSourceContext(
      { ...initial, complete: false },
      snapshot(root),
    );
    expect(enriched.complete).toBe(false);
    expect(mutations(enriched).files[0]?.hunks).toEqual([
      {
        before: { startLine: 1, lineCount: 0, text: "" },
        after: { startLine: 1, lineCount: 1, text: "new\r\n" },
      },
    ]);
    const missing = await evidence(root, { path: "absent.txt", content: "new" }, "write");
    expect(mutations(missing).files[0]?.status).toBe("unavailable");
    expect(mutations(missing).files[0]?.hunks).toBeUndefined();
    expect(await readFile(join(root, "empty.txt"), "utf8")).toBe("");
  });

  it("omits oversized whole hunks, labels partial mutations, and retains bounded original evidence", async () => {
    const root = await project();
    const original = "small\nkeep\n" + "x".repeat(5000) + "\n";
    const content = "new\nkeep\n" + "y".repeat(5000) + "\n";
    await writeFile(join(root, "module.txt"), original);
    const state = await evidence(root, { path: "module.txt", content }, "write");
    expect(mutations(state).files[0]).toMatchObject({
      status: "partial",
      hunks: [{ before: { text: "small\n" }, after: { text: "new\n" } }],
    });
    expect(state.details.content).toBe(content);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          sourceContext: state.details.sourceContext,
          mutationContext: state.details.mutationContext,
        }),
      ),
    ).toBeLessThanOrEqual(8192);
    expect(state.complete).toBe(true);
    expect(await readFile(join(root, "module.txt"), "utf8")).toBe(original);
  });

  it("rejects multiplicative replacement growth before materializing an unbounded proposal", async () => {
    const root = await project();
    const original = "x".repeat(1000);
    const newString = "y".repeat(1000);
    await writeFile(join(root, "module.txt"), original);
    const state = await evidence(root, {
      path: "module.txt",
      old_string: "x",
      new_string: newString,
      replace_all: true,
    });
    expect(mutations(state).files[0]?.status).toBe("unavailable");
    expect(mutations(state).files[0]?.hunks).toBeUndefined();
    expect(source(state).files[0]?.ranges?.[0]?.text).toBe(original);
    expect(state.details.new_string).toBe(newString);
    expect(await readFile(join(root, "module.txt"), "utf8")).toBe(original);
  });
});
