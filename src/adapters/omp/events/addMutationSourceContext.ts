import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import type { PolicyAction, PolicyActionDetail } from "../../../policy/actions/types.js";
import type { PolicySnapshot } from "../../../policy/snapshots/types.js";
import {
  isPolicyPathWithin,
  resolveLocalPolicyPath,
} from "../../../policy/sources/selectApplicableRules.js";
import { evaluateLocalPolicy } from "../enforcement/evaluateLocalPolicy.js";
import { deriveMutationContext, type MutationFile } from "./deriveMutationContext.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 8 * 1024 - 64; // Include the added detail key and JSON separators.
const MAX_PATHS = 8;
const NEIGHBOR_LINES = 3;
const MAX_WINDOWS = 16;

type SourceRange = { startLine: number; endLine: number; text: string };
type SourceFile = {
  path: string;
  status: "included" | "partial" | "unavailable";
  ranges?: SourceRange[];
  reason?: string;
};
type SourceContext = { phase: "before"; files: SourceFile[] };
type EvidenceFile = { source: SourceFile; mutation: MutationFile };

/** Optional before/proposed evidence, never an executed edit or an authorization. */
export async function addMutationSourceContext(
  action: PolicyAction,
  snapshot: PolicySnapshot,
  signal?: AbortSignal,
): Promise<PolicyAction> {
  signal?.throwIfAborted();
  if (
    action.hostAction.host !== "omp" ||
    !["write", "edit"].includes(action.hostAction.name) ||
    action.operation !== "write" ||
    action.interception !== "precise" ||
    (action.hostAction.source !== undefined && action.hostAction.source.kind !== "builtin") ||
    action.details.tool !== action.hostAction.name
  ) {
    return action;
  }

  // Serialized bytes overestimate the provider's string-character accounting.
  // Reserve room for keys, metadata, and targets; never displace mutation input.
  const budget = Math.min(
    MAX_CONTEXT_BYTES,
    32_000 - serializedBytes([action.details, action.targets]) - 1024,
  );
  if (budget < 256) return action;
  const paths = [
    ...new Set(
      action.targets.filter((target) => target.kind === "path").map((target) => target.value),
    ),
  ];
  if (paths.length === 0) return action;
  const context: SourceContext = { phase: "before", files: [] };
  const mutationContext: { phase: "proposed"; files: MutationFile[] } = {
    phase: "proposed",
    files: [],
  };
  const evidenceBytes = (): number => serializedBytes({ sourceContext: context, mutationContext });
  for (const path of paths.slice(0, MAX_PATHS)) {
    const file: SourceFile = { path, status: "unavailable", reason: "evidence budget exhausted" };
    context.files.push(file);
    mutationContext.files.push({ ...file });
    if (evidenceBytes() > budget) {
      context.files.pop();
      mutationContext.files.pop();
      break;
    }
  }
  if (context.files.length === 0) return action;
  let root: string | undefined;
  try {
    root = await realpath(snapshot.projectRoot);
  } catch {
    // Filesystem failures are unavailable evidence, not policy denials.
  }
  signal?.throwIfAborted();
  for (const [index, file] of context.files.entries()) {
    signal?.throwIfAborted();
    const mutation = mutationContext.files[index];
    if (mutation === undefined) continue;
    const remaining = budget - evidenceBytes() + serializedBytes(file) + serializedBytes(mutation);
    // Reserve every target's metadata before adding source bodies. Long paths
    // and near-limit mutation inputs may leave no room even for a read result.
    if (2 * serializedBytes({ ...file, reason: "x".repeat(96) }) > remaining) continue;
    const reason =
      paths.length > MAX_PATHS && index === MAX_PATHS - 1
        ? "target limit: this and additional targets omitted"
        : root === undefined
          ? "project root unavailable"
          : undefined;
    if (reason !== undefined) {
      context.files[index] = { ...file, reason };
      mutationContext.files[index] = { ...mutation, reason };
    } else if (root !== undefined) {
      const evidence = await readSource(action, snapshot, root, file.path, remaining, signal);
      context.files[index] = evidence.source;
      mutationContext.files[index] = evidence.mutation;
    }
  }
  signal?.throwIfAborted();
  return { ...action, details: { ...action.details, sourceContext: context, mutationContext } };
}

async function readSource(
  action: PolicyAction,
  snapshot: PolicySnapshot,
  root: string,
  path: string,
  budget: number,
  signal?: AbortSignal,
): Promise<EvidenceFile> {
  const unavailable = (reason: string): EvidenceFile => ({
    source: { path, status: "unavailable", reason },
    mutation: { path, status: "unavailable", reason },
  });
  // Mutation selectors, archives, resource URIs, and wildcards are not local files.
  // Encoded literal punctuation remains supported by the shared path resolver.
  if (/[:?#]/u.test(path)) return unavailable("unsupported local path or selector");
  const lexical = resolveLocalPolicyPath(path, action.workingDirectory);
  if (lexical === undefined) return unavailable("unsupported local path");

  let handle: FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    const canonical = await realpath(lexical);
    if (!isPolicyPathWithin(root, canonical)) return unavailable("outside project");
    const readAction: PolicyAction = {
      ...action,
      operation: "read",
      details: { tool: "read", path },
      targets: [
        { kind: "path", value: lexical },
        { kind: "path", value: canonical },
      ],
      hostAction: { host: "omp", name: "read", input: { path: lexical } },
    };
    if ((await evaluateLocalPolicy(readAction, snapshot))?.effect === "deny") {
      return unavailable("read prohibited by local policy");
    }
    signal?.throwIfAborted();
    const before = await lstat(canonical);
    if (!before.isFile()) return unavailable("not a regular file");
    if (before.size > MAX_FILE_BYTES) return unavailable("file size limit");
    // NOFOLLOW rejects a replaced final symlink; NONBLOCK avoids blocking on a
    // regular file replaced by a FIFO. Identity checks also cover renamed parents.
    handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (await realpath(lexical)) !== canonical ||
      (await realpath(canonical)) !== canonical
    ) {
      return unavailable("file changed during inspection");
    }
    if (opened.size > MAX_FILE_BYTES) return unavailable("file size limit");
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    const current = await lstat(canonical);
    if (
      offset !== bytes.length ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      (await realpath(lexical)) !== canonical ||
      (await realpath(canonical)) !== canonical
    ) {
      return unavailable("file changed during inspection");
    }
    signal?.throwIfAborted();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return unavailable("source is not UTF-8 text");
    }
    if (text.includes("\0")) return unavailable("source is not text");
    // Reserve room for both views. Never truncate a hunk's text into a false
    // complete mutation; omit whole hunks and mark partial evidence instead.
    const mutation = boundMutation(
      deriveMutationContext(action, path, text),
      Math.floor(budget / 2),
    );
    const source = selectSource(action, path, text, budget - serializedBytes(mutation));
    return { source, mutation };
  } catch (error) {
    signal?.throwIfAborted();
    return unavailable(
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "file does not exist"
        : "file inspection unavailable",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function boundMutation(file: MutationFile, budget: number): MutationFile {
  if (serializedBytes(file) <= budget) return file;
  const bounded: MutationFile = {
    path: file.path,
    status: "partial",
    hunks: [],
    reason: "mutation evidence budget; remaining changes omitted",
  };
  for (const hunk of file.hunks ?? []) {
    bounded.hunks?.push(hunk);
    if (serializedBytes(bounded) > budget) bounded.hunks?.pop();
  }
  return bounded.hunks?.length
    ? bounded
    : { path: file.path, status: "unavailable", reason: "mutation exceeds evidence budget" };
}

function selectSource(
  action: PolicyAction,
  path: string,
  text: string,
  budget: number,
): SourceFile {
  // Keep original newlines (including CRLF), with no synthetic trailing line.
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const full: SourceFile = {
    path,
    status: "included",
    ranges: lines.length === 0 ? [] : [{ startLine: 1, endLine: lines.length, text }],
  };
  if (serializedBytes(full) <= budget) return full;
  const hints = sourceHints(action, path, text);
  if (hints.lines.length === 0) {
    return {
      path,
      status: "unavailable",
      reason: hints.reason ?? "file exceeds evidence budget; no supported source location",
    };
  }
  const windows = hints.lines
    .filter((line) => Number.isSafeInteger(line) && line >= 1 && line <= lines.length)
    .slice(0, MAX_WINDOWS)
    .map((line) => ({
      start: Math.max(1, line - NEIGHBOR_LINES),
      end: Math.min(lines.length, line + NEIGHBOR_LINES),
    }))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous !== undefined && window.start <= previous.end + 1)
      previous.end = Math.max(previous.end, window.end);
    else merged.push(window);
  }
  const result: SourceFile = {
    path,
    status: "partial",
    ranges: [],
    reason: hints.reason ?? "source windows only; remaining source omitted",
  };
  for (const window of merged) {
    const range = {
      startLine: window.start,
      endLine: window.end,
      text: lines.slice(window.start - 1, window.end).join(""),
    };
    result.ranges?.push(range);
    if (serializedBytes(result) > budget) result.ranges?.pop();
  }
  return result.ranges?.length
    ? result
    : { path, status: "unavailable", reason: "source locations outside file or evidence budget" };
}

/** Extract coordinates/old text only: do not execute, validate, or simulate edits. */
function sourceHints(
  action: PolicyAction,
  path: string,
  text: string,
): { lines: number[]; reason?: string } {
  const lines: number[] = [];
  let reason: string | undefined;
  function oldText(value: unknown): void {
    if (typeof value !== "string" || value.length === 0) return;
    const index = text.indexOf(value);
    if (index < 0) {
      reason = "old source text not found; any shown windows are partial";
      return;
    }
    if (text.indexOf(value, index + 1) >= 0) {
      reason = "ambiguous old source text; any shown windows are partial";
      return;
    }
    const start = text.slice(0, index).split("\n").length;
    lines.push(start, start + value.split("\n").length - 1);
  }
  function diff(value: string): void {
    let old: string[] = [];
    const flush = (): void => {
      if (old.length > 0) oldText(old.join("\n"));
      old = [];
    };
    for (const row of value.split("\n")) {
      const coordinate = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(row);
      if (coordinate !== null) {
        flush();
        const start = Math.max(1, Number(coordinate[1]));
        lines.push(start, start + Math.max(1, Number(coordinate[2] ?? 1)) - 1);
      } else if (row.startsWith("@@")) flush();
      else if (row.startsWith(" ") || (row.startsWith("-") && !row.startsWith("---")))
        old.push(row.slice(1));
      else if (!row.startsWith("+")) flush();
    }
    flush();
  }
  const details = action.details;
  if (details.path === path) {
    oldText(details.old_string);
    if (Array.isArray(details.edits)) {
      for (const edit of details.edits) {
        if (edit === null || typeof edit !== "object" || Array.isArray(edit)) continue;
        const fields = edit as { readonly [key: string]: PolicyActionDetail };
        oldText(fields.old_string);
        if (typeof fields.diff === "string") diff(fields.diff);
      }
    }
  }
  if (typeof details.input === "string") {
    let selected = false;
    let section: string[] = [];
    const flush = (): void => {
      if (selected) diff(section.join("\n"));
      section = [];
    };
    for (const row of details.input.split("\n")) {
      const header = /^\[(.+)#[A-F0-9]{4}\]$|^\*\*\* (?:Update|Add|Delete) File: (.+)$/u.exec(row);
      if (header !== null) {
        flush();
        selected = (header[1] ?? header[2]) === path;
        continue;
      }
      if (!selected) continue;
      const anchor = /^(?:PUT|CUT) (?:[<>])?(\d+)(?:\.=([0-9]+))?(?:\*|(?=[: @]|$))/u.exec(row);
      if (anchor !== null) {
        lines.push(Number(anchor[1]));
        if (anchor[2] !== undefined) lines.push(Number(anchor[2]));
      } else if (row.startsWith("PUT >$")) {
        lines.push((text.match(/\n/gu)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1));
      }
      section.push(row);
    }
    flush();
  }
  return { lines, ...(reason === undefined ? {} : { reason }) };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
