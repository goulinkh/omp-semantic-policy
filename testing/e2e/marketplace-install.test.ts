import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPolicyRepository } from "../../src/adapters/omp/persistence/createPolicyRepository.js";

const repositoryRoot = resolve(import.meta.dir, "../..");
const cli = join(repositoryRoot, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const fixture = join(import.meta.dir, "fixtures/native-policy-provider.ts");
type Frame = Record<string, unknown>;

/** Explicit opt-in: builds and tests the actual distributable with the pinned native OMP CLI. */
describe.skipIf(process.env.OMP_MARKETPLACE_E2E !== "1")("native marketplace distribution", () => {
  test("installs an isolated copy and enforces once with installed-only and duplicate source loading", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omp-marketplace-regression-")));
    const home = join(root, "home");
    const project = join(root, "project");
    const profile = join(home, ".omp/profiles/smoke");
    const env = {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: root,
      TERM: "dumb",
      NO_COLOR: "1",
    };
    try {
      await Promise.all([mkdir(home), mkdir(project)]);
      await writeFile(join(project, "AGENTS.md"), "Never write `protected.txt`.\n");
      await writeFile(join(project, "protected.txt"), "unchanged\n");
      await run(["git", "init", "--quiet"], project, env);
      const omp = [process.execPath, cli, "--profile", "smoke"];
      await run([...omp, "plugin", "marketplace", "add", repositoryRoot], project, env);
      await run([...omp, "plugin", "install", "omp-semantic-policy@goulinkh"], project, env);
      const listed = object(
        JSON.parse(await run([...omp, "plugin", "list", "--json"], project, env)),
      );
      const plugin = object(array(listed.marketplace)[0]);
      expect(plugin.id).toBe("omp-semantic-policy@goulinkh");
      const entry = object(array(plugin.entries)[0]);
      if (typeof entry.installPath !== "string")
        throw new Error("Native install did not report its path");
      const installed = entry.installPath;
      expect((await lstat(installed)).isSymbolicLink()).toBe(false);
      expect(await realpath(installed)).toStartWith(`${home}/`);
      const installedFiles = await readdir(installed, { recursive: true });
      for (const excluded of ["node_modules", "src", ".git"]) {
        expect(installedFiles.some((path) => path.split(/[\\/]/u).includes(excluded))).toBe(false);
      }
      expect(await readFile(join(installed, "index.js"))).toEqual(
        await readFile(join(repositoryRoot, "dist/index.js")),
      );
      expect((await lstat(join(installed, "index.js"))).isSymbolicLink()).toBe(false);
      const manifest = object(JSON.parse(await readFile(join(installed, "package.json"), "utf8")));
      const sourceManifest = object(
        JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")),
      );
      expect(entry.version).toBe(sourceManifest.version);
      expect(manifest.version).toBe(sourceManifest.version);
      expect(manifest.dependencies).toBeUndefined();

      // No real credentials enter the child, and no remote policy inference is consented to.
      const databasePath = join(profile, "agent/policy.db");
      const policy = await createPolicyRepository(databasePath);
      policy.setRemoteConsent(false);
      policy.close();
      for (const sourceCopy of [false, true]) {
        const runId = sourceCopy ? "duplicate" : "installed";
        const frames = await exerciseNativeHost(
          [
            ...omp,
            "--mode",
            "rpc",
            "--no-session",
            "--no-title",
            "--no-lsp",
            "--no-skills",
            "--tools",
            "write",
            "--model",
            "policy-smoke/local",
            "-e",
            fixture,
            ...(sourceCopy ? ["-e", join(repositoryRoot, "src/index.ts")] : []),
          ],
          project,
          { ...env, POLICY_SMOKE_RUN_ID: runId },
          sourceCopy ? 2 : 1,
        );
        const results = frames.filter((frame) => frame.type === "tool_execution_end");
        expect(results.map((frame) => [frame.toolCallId, frame.isError])).toEqual([
          [`${runId}-documentation`, false],
          [`${runId}-protected`, true],
        ]);
        expect(await readFile(join(project, "development.md"), "utf8")).toBe(
          "Development only: bun run build, then omp plugin link .\n",
        );
        expect(await readFile(join(project, "protected.txt"), "utf8")).toBe("unchanged\n");
        const blocked = object(results[1]?.result);
        const feedback = object(array(blocked.content)[0]).text;
        expect(feedback).not.toContain(`${runId}-protected`);
        expect(feedback).toContain("AGENTS.md");
        expect(feedback).toContain("/policy audit");

        const auditStore = await createPolicyRepository(databasePath);
        try {
          const audits = auditStore.listAudits(project);
          for (const suffix of ["documentation", "protected"]) {
            const matching = audits.filter((audit) => audit.actionId === `${runId}-${suffix}`);
            expect(matching.map((audit) => audit.phase).sort()).toEqual(["decision", "result"]);
            expect(matching.find((audit) => audit.phase === "result")?.outcome).toBe(
              suffix === "protected" ? "blocked" : "success",
            );
          }
          const snapshot = auditStore.getActiveSnapshot(project);
          expect(snapshot?.rules.map((rule) => rule.statement)).toEqual([
            "Never write `protected.txt`.",
          ]);
        } finally {
          auditStore.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

async function run(command: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}): ${stderr}\n${stdout}`);
  return stdout;
}

async function exerciseNativeHost(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  extensionCopies: number,
): Promise<Frame[]> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 45_000,
  });
  const frames: Frame[] = [];
  const stderr = new Response(child.stderr).text();
  let readError: unknown;
  const waiters: {
    readonly predicate: (frame: Frame) => boolean;
    readonly resolve: (frame: Frame) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  function failWaiters(error: unknown): void {
    readError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }
  function accept(frame: Frame): void {
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (waiter.predicate(frame)) {
        waiters.splice(index, 1);
        waiter.resolve(frame);
      }
    }
  }
  const reading = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line.startsWith("{")) accept(object(JSON.parse(line)));
      }
    }
  })().catch(failWaiters);
  void child.exited.then(async (code) => {
    failWaiters(new Error(`OMP exited (${code}) before expected RPC event: ${await stderr}`));
  });
  function waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const matched = frames.find(predicate);
    if (matched !== undefined) return Promise.resolve(matched);
    if (readError !== undefined) return Promise.reject(readError);
    const { promise, resolve, reject } = Promise.withResolvers<Frame>();
    waiters.push({ predicate, resolve, reject });
    return promise;
  }
  async function send(frame: Frame): Promise<void> {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    await child.stdin.flush();
  }
  try {
    await waitFor((frame) => frame.type === "ready");
    // Each independently loaded copy onboards after RPC startup. A placeholder
    // status (or another copy's completion) does not make the command owner ready.
    await waitFor(
      () =>
        frames.filter(
          (frame) =>
            frame.method === "setStatus" &&
            frame.statusKey === "omp-semantic-policy" &&
            /(?:active|evaluator disabled)$/u.test(String(frame.statusText)),
        ).length >= extensionCopies,
    );
    await send({ id: "status", type: "prompt", message: "/policy status" });
    const status = await waitFor(
      (frame) => frame.type === "prompt_result" && frame.id === "status",
    );
    expect(status.agentInvoked).toBe(false);
    expect(
      frames.filter((frame) => frame.method === "notify").map((frame) => frame.message),
    ).toContainEqual(expect.stringContaining(cwd));
    const commands = await waitFor((frame) => frame.type === "available_commands_update");
    expect(array(commands.commands).some((entry) => object(entry).name === "policy")).toBe(true);
    await send({
      id: "actions",
      type: "prompt",
      message: "Exercise the disposable native policy fixture.",
    });
    await waitFor((frame) => frame.type === "agent_end" && frame.isTerminal === true);
    return frames;
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await child.exited;
    await reading;
    await stderr;
  }
}

function object(value: unknown): Frame {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected native JSON object");
  return value as Frame;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected native JSON array");
  return value;
}
