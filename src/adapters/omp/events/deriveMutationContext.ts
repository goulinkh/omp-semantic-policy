import {
  hashlineFileHash,
  hashlineStripPrefixes,
  structuredPatchHunks,
  summarizeCode,
} from "@oh-my-pi/pi-natives";
import type { PolicyAction } from "../../../policy/actions/types.js";

type MutationRange = { startLine: number; lineCount: number; text: string };
export type MutationFile = {
  path: string;
  status: "included" | "partial" | "unavailable";
  hunks?: { before: MutationRange; after: MutationRange }[];
  reason?: string;
};
type LineEdit = { start: number; end: number; rows: string[] };

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_HUNKS = 32;

/** Pure projection of supported native edits; never invokes an EditSession or a file API. */
export function deriveMutationContext(
  action: PolicyAction,
  path: string,
  original: string,
): MutationFile {
  try {
    const input = action.hostAction.input;
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
      fail("mutation input size limit");
    // Native edit projects notebooks, and write may strip copied read-display prefixes.
    // Neither projection can safely be inferred as a plain-text mutation here.
    if (/\.ipynb$/iu.test(path)) fail("notebook mutation requires native projection");
    let proposed: string;
    if (action.hostAction.name === "write") {
      if (input.path !== path || typeof input.content !== "string") fail("unsupported write input");
      const rows = input.content.split("\n");
      if (
        hashlineStripPrefixes(rows).join("\n") !== input.content ||
        /^\s*\[.*#[^\]]+\]/mu.test(input.content)
      ) {
        fail("write display-prefix handling depends on host settings");
      }
      proposed = input.content;
    } else {
      const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
      const body = original.slice(bom.length);
      const crlf = body.indexOf("\r\n");
      const ending = crlf >= 0 && crlf < body.indexOf("\n") ? "\r\n" : "\n";
      const normalized = lf(body);
      let after: string;
      if (typeof input.input === "string") {
        after = envelope(input.input, path, normalized);
      } else {
        if (input.path !== path) fail("no supported mutation for target");
        const entries = input.edits === undefined ? [input] : input.edits;
        if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64)
          fail("unsupported edit batch");
        after = normalized;
        let patchMode: boolean | undefined;
        // Native JSON edit batches run sequentially. Coordinates within each
        // unified patch (and within a hashline section) refer to its original.
        for (const value of entries) {
          const entry = record(value);
          const isPatch = typeof entry.diff === "string";
          if (
            (patchMode !== undefined && patchMode !== isPatch) ||
            (isPatch && input.edits === undefined)
          )
            fail("mixed or unsupported native edit modes");
          patchMode = isPatch;
          if (entry.rename !== undefined || (entry.op !== undefined && entry.op !== "update"))
            fail("unsupported file operation");
          if (typeof entry.diff === "string" && entry.old_string === undefined) {
            after = unified(entry.diff, after);
          } else {
            if (
              typeof entry.old_string !== "string" ||
              typeof entry.new_string !== "string" ||
              entry.diff !== undefined
            )
              fail("unsupported replacement input");
            const old = lf(entry.old_string);
            const next = lf(entry.new_string);
            if (old.length === 0) fail("empty replacement selector");
            const at = after.indexOf(old);
            if (at < 0) fail("exact replacement source not found");
            if (entry.replace_all !== undefined && typeof entry.replace_all !== "boolean")
              fail("unsupported replacement flag");
            if (entry.replace_all === true) {
              let count = 0;
              for (let offset = at; offset >= 0; offset = after.indexOf(old, offset + old.length))
                count++;
              if (
                Buffer.byteLength(after) +
                  count * (Buffer.byteLength(next) - Buffer.byteLength(old)) >
                MAX_INPUT_BYTES * 2
              )
                fail("derived mutation size limit");
              after = after.split(old).join(next);
            } else {
              if (after.indexOf(old, at + 1) >= 0) fail("ambiguous replacement source");
              after = after.slice(0, at) + next + after.slice(at + old.length);
            }
          }
          if (Buffer.byteLength(after) > MAX_INPUT_BYTES * 2) fail("derived mutation size limit");
        }
      }
      proposed = bom + (ending === "\r\n" ? after.replace(/\n/gu, "\r\n") : after);
    }
    const beforeLines = original.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    const afterLines = proposed.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    const hunks = structuredPatchHunks(original, proposed, 0).map((hunk) => ({
      // Native hunks already name the 1-based gap for an empty side.
      before: range(beforeLines, hunk.oldStart, hunk.oldLines),
      after: range(afterLines, hunk.newStart, hunk.newLines),
    }));
    return hunks.length > MAX_HUNKS
      ? {
          path,
          status: "partial",
          hunks: hunks.slice(0, MAX_HUNKS),
          reason: "mutation hunk limit; remaining changes omitted",
        }
      : { path, status: "included", hunks };
  } catch (error) {
    return {
      path,
      status: "unavailable",
      reason:
        error instanceof UnsupportedMutation ? error.message : "mutation derivation unavailable",
    };
  }
}

class UnsupportedMutation extends Error {}
function fail(reason: string): never {
  throw new UnsupportedMutation(reason);
}
function lf(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}
// Byte-preserving line slices deliberately keep CRLF and the final newline.
function range(lines: string[], startLine: number, lineCount: number): MutationRange {
  return {
    startLine,
    lineCount,
    text: lines.slice(startLine - 1, startLine - 1 + lineCount).join(""),
  };
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("unsupported edit entry");
  return value as Record<string, unknown>;
}

function envelope(input: string, path: string, text: string): string {
  const rows = lf(input).split("\n");
  if (rows.at(-1) === "") rows.pop();
  if (rows.shift() !== "*** Begin Patch" || rows.pop() !== "*** End Patch")
    fail("incomplete patch envelope");
  const sections: { path: string; tag?: string; rows: string[] }[] = [];
  for (const row of rows) {
    const header = /^\[(.+)#([A-F0-9]{4})\]$/u.exec(row);
    const update = /^\*\*\* Update File: (.+)$/u.exec(row);
    if (header !== null || update !== null) {
      sections.push({
        path: header?.[1] ?? update?.[1] ?? "",
        ...(header === null ? {} : { tag: header[2] }),
        rows: [],
      });
    } else {
      const section = sections.at(-1);
      if (section === undefined || row.startsWith("*** "))
        fail("unsupported patch section or file operation");
      section.rows.push(row);
    }
  }
  if (sections.some((section) => (section.tag === undefined) !== (sections[0]?.tag === undefined)))
    fail("mixed native patch grammars");
  const selected = sections.filter((section) => section.path === path);
  if (selected.length !== 1) fail("missing or repeated mutation section");
  const section = selected[0];
  if (section === undefined) fail("missing mutation section");
  return section.tag === undefined
    ? unified(section.rows.join("\n"), text)
    : hashline(section.rows, section.tag, path, text);
}

function hashline(rows: string[], tag: string, path: string, text: string): string {
  if (hashlineFileHash(text) !== tag) fail("stale hashline snapshot; host recovery unavailable");
  const lines = text.split("\n");
  const contentCount = lines.length - (text.endsWith("\n") ? 1 : 0);
  const edits: LineEdit[] = [];
  let tail: string[] | undefined;
  let hasReplacement = false;
  for (let index = 0; index < rows.length;) {
    const row = rows[index++] ?? "";
    const cut = /^CUT ([1-9]\d*)\.=([1-9]\d*)$/u.exec(row);
    const put = /^PUT (?:([1-9]\d*)\.=([1-9]\d*)|([<>])([1-9]\d*)|(>\$)):$/u.exec(row);
    if (cut === null && put === null)
      fail("unsupported hashline selector, register, or file operation");
    const body: string[] = [];
    if (put !== null) {
      while (rows[index]?.startsWith("+")) body.push((rows[index++] ?? "").slice(1));
      if (body.length === 0) fail("empty hashline PUT body");
      if (hashlineStripPrefixes(body).join("\n") !== body.join("\n"))
        fail("hashline display-prefix body requires native recovery");
    }
    let start: number;
    let end: number;
    if (cut !== null || put?.[1] !== undefined) {
      start = Number(cut?.[1] ?? put?.[1]) - 1;
      end = Number(cut?.[2] ?? put?.[2]);
      if (start < 0 || end <= start || end > contentCount)
        fail("hashline range outside original content");
      if (put !== null) {
        hasReplacement = true;
        // Native may remove echoed neighboring rows or auto-shift indentation.
        // Do not claim that an authored body survives these repairs unchanged.
        const precedingIndent = /^[\t ]*/u.exec(lines[start - 1] ?? "")?.[0].length ?? 0;
        const sourceIndent = /^[\t ]*/u.exec(lines[start] ?? "")?.[0].length ?? 0;
        const bodyIndent = /^[\t ]*/u.exec(body[0] ?? "")?.[0].length ?? 0;
        if (
          boundaryEcho(lines, start, end, body) ||
          (lines[start - 1]?.trimEnd().endsWith("{") &&
            body.length === end - start &&
            sourceIndent > precedingIndent &&
            bodyIndent <= precedingIndent)
        ) {
          fail("hashline boundary or indentation repair requires native execution context");
        }
      }
    } else if (put?.[5] !== undefined) {
      if (tail !== undefined) fail("ambiguous repeated end-of-file insertion");
      tail = body;
      continue;
    } else {
      const anchor = Number(put?.[4]);
      if (!Number.isSafeInteger(anchor) || anchor < 1 || anchor > contentCount)
        fail("hashline gap outside original content");
      start = anchor - (put?.[3] === "<" ? 1 : 0);
      end = start;
      if (put?.[3] === ">") {
        const anchorIndent = /^[\t ]*/u.exec(lines[anchor - 1] ?? "")?.[0] ?? "";
        if (body.some((line) => line.trim() !== "" && !line.startsWith(anchorIndent))) {
          fail("hashline insertion landing may require native repair");
        }
      }
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end))
      fail("invalid hashline coordinates");
    edits.push({ start, end, rows: body });
  }
  if (edits.length === 0 && tail === undefined) fail("empty hashline section");
  let result = splice(lines, edits);
  if (tail !== undefined) {
    if (result.length === 1 && result[0] === "") result = tail;
    else result.splice(result.at(-1) === "" ? result.length - 1 : result.length, 0, ...tail);
  }
  const after = result.join("\n");
  // Native repairs syntax-breaking replacement boundaries. The pure syntax
  // helper reads only the supplied string. Unknown grammars cannot perform
  // syntax repairs; conservatively reject potentially repairable boundaries.
  if (hasReplacement && !summarizeCode({ code: after, path }).parsed) {
    if (summarizeCode({ code: text, path }).parsed)
      fail("hashline syntax-boundary repair is unavailable");
    for (const edit of edits.filter((item) => item.end > item.start && item.rows.length > 0)) {
      const oldRows = lines.slice(edit.start, edit.end);
      const edges = [
        oldRows[0] ?? "",
        oldRows.at(-1) ?? "",
        edit.rows[0] ?? "",
        edit.rows.at(-1) ?? "",
      ];
      if (edges.some((line) => /^[\t ]+/u.test(line) || /^[\s]*[)\]}]/u.test(line)))
        fail("hashline syntax-boundary repair is unavailable");
    }
  }
  return after;
}

function boundaryEcho(lines: string[], start: number, end: number, body: string[]): boolean {
  for (let count = 1; count <= body.length; count++) {
    if (
      count <= start &&
      body.slice(0, count).some((line) => line.trim() !== "") &&
      body.slice(0, count).every((line, offset) => line === lines[start - count + offset])
    )
      return true;
    if (
      end + count <= lines.length &&
      body.slice(-count).some((line) => line.trim() !== "") &&
      body.slice(-count).every((line, offset) => line === lines[end + offset])
    )
      return true;
  }
  return false;
}

/** Apply nonoverlapping edits against original line coordinates, never shifted coordinates. */
function splice(lines: string[], edits: LineEdit[]): string[] {
  edits.sort((a, b) => a.start - b.start);
  let previous: LineEdit | undefined;
  for (const edit of edits) {
    if (previous !== undefined && (edit.start < previous.end || edit.start === previous.start))
      fail("overlapping or ambiguous mutation ranges");
    previous = edit;
  }
  const result: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    result.push(...lines.slice(cursor, edit.start), ...edit.rows);
    cursor = edit.end;
  }
  result.push(...lines.slice(cursor));
  return result;
}

/** Exact subset of native patch mode; hints are 1-based even for pure insertions. */
function unified(diff: string, text: string): string {
  const rows = lf(diff).split("\n");
  if (rows.at(-1) === "") rows.pop();
  const lines = text.split("\n");
  const trailing = text.endsWith("\n");
  if (trailing) lines.pop();
  const edits: LineEdit[] = [];
  for (let index = 0; index < rows.length;) {
    const header = rows[index++] ?? "";
    const coordinate = /^@@ -([1-9]\d*)(?:,(\d+))? \+([1-9]\d*)(?:,(\d+))? @@$/u.exec(header);
    if (header !== "@@" && coordinate === null) fail("unsupported unified patch header");
    if (
      coordinate !== null &&
      [coordinate[1], coordinate[3]].some(
        (value) => !Number.isSafeInteger(Number(value)) || Number(value) > 0xffff_ffff,
      )
    )
      fail("invalid unified patch coordinates");
    const before: string[] = [];
    const after: string[] = [];
    let context = false;
    while (index < rows.length && !rows[index]?.startsWith("@@")) {
      const row = rows[index++] ?? "";
      if (row.startsWith(" ")) {
        context = true;
        before.push(row.slice(1));
        after.push(row.slice(1));
      } else if (row.startsWith("-")) before.push(row.slice(1));
      else if (row.startsWith("+")) after.push(row.slice(1));
      else fail("unsupported unified patch row or newline marker");
    }
    if (
      coordinate !== null &&
      (Number(coordinate[2] ?? 1) !== before.length || Number(coordinate[4] ?? 1) !== after.length)
    )
      fail("unified patch counts do not match body");
    let start: number;
    if (before.length === 0) {
      if (coordinate === null) fail("unanchored patch insertion");
      start = Number(coordinate[1]) - 1;
    } else {
      const positions: number[] = [];
      for (let at = 0; at <= lines.length - before.length; at++) {
        if (before.every((line, offset) => line === lines[at + offset])) positions.push(at);
        if (positions.length > 1) fail("ambiguous unified patch source");
      }
      if (positions.length !== 1) fail("exact unified patch source not found");
      start = positions[0] ?? -1;
      if (coordinate !== null && Number(coordinate[1]) !== start + 1)
        fail("unified patch coordinate differs from exact source");
      // A context-free @@ uses native character matching; whole-line matches
      // must also be unique as substrings to rule out a different native match.
      if (coordinate === null && !context && edits.length === 0 && index === rows.length) {
        const needle = before.join("\n");
        const at = text.indexOf(needle);
        if (needle === "" || text.indexOf(needle, at + 1) >= 0)
          fail("ambiguous context-free patch source");
        let replaced = text.slice(0, at) + after.join("\n") + text.slice(at + needle.length);
        if (trailing && !replaced.endsWith("\n")) replaced += "\n";
        if (!trailing) replaced = replaced.replace(/\n+$/u, "");
        return replaced;
      }
    }
    if (!Number.isSafeInteger(start) || start < 0 || start + before.length > lines.length)
      fail("unified patch range outside original content");
    if (edits.some((edit) => start < edit.end))
      fail("unordered or overlapping unified patch hunks");
    edits.push({ start, end: start + before.length, rows: after });
  }
  if (edits.length === 0) fail("empty unified patch");
  const result = splice(lines, edits);
  if (trailing) result.push("");
  let after = result.join("\n");
  if (trailing && !after.endsWith("\n")) after += "\n";
  if (!trailing) after = after.replace(/\n+$/u, "");
  return after;
}
