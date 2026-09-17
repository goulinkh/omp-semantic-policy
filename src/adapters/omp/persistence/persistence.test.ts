import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyAuditRecord, PolicySnapshot } from "../../../policy/index.js";
import { createPolicyRepository } from "./createPolicyRepository.js";
import {
  applyPolicyDatabaseMigrations,
  POLICY_DATABASE_MIGRATIONS,
  type PolicyDatabaseMigration,
} from "./migrations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("policy persistence", () => {
  test("stores immutable snapshots, stale state, consent, and redacted audits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-policy-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "private", "policy.db");
    const repository = await createPolicyRepository(databasePath);
    const snapshot = createSnapshot("snapshot-1");
    const audit = createAudit(snapshot);

    repository.saveSnapshot(snapshot);
    repository.setRemoteConsent(true, 20);
    repository.appendAudit(audit);

    expect(repository.getProject(snapshot.projectRoot)).toEqual({
      projectRoot: snapshot.projectRoot,
      activeSnapshotId: snapshot.id,
      stale: false,
      lastSeenAtMs: snapshot.createdAtMs,
    });
    expect(repository.getActiveSnapshot(snapshot.projectRoot)).toEqual(snapshot);
    expect(repository.getRemoteConsent()).toBe(true);
    expect(repository.listAudits(snapshot.projectRoot)).toEqual([audit]);

    repository.markStale(snapshot.projectRoot);
    expect(repository.getProject(snapshot.projectRoot)?.stale).toBe(true);
    repository.close();

    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
  });

  test("returns only the latest requested audits in project-local chronological order", async () => {
    const repository = await createPolicyRepository(":memory:");
    const snapshot = createSnapshot("project-a");
    const other = { ...createSnapshot("project-b"), projectRoot: "/workspace/other" };
    repository.saveSnapshot(snapshot);
    repository.saveSnapshot(other);
    for (const actionId of ["oldest", "middle", "newest"]) {
      repository.appendAudit({ ...createAudit(snapshot), actionId });
      repository.appendAudit({ ...createAudit(other), actionId: `other-${actionId}` });
    }
    expect(repository.listAudits(snapshot.projectRoot, 2).map((audit) => audit.actionId)).toEqual([
      "middle",
      "newest",
    ]);
    expect(() => repository.listAudits(snapshot.projectRoot, 0)).toThrow(RangeError);
    repository.close();
  });

  test("applies migrations idempotently", () => {
    const database = new Database(":memory:", { strict: true });
    applyPolicyDatabaseMigrations(database);
    applyPolicyDatabaseMigrations(database);

    const rows = database
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    expect(rows.map((row) => row.version)).toEqual(
      POLICY_DATABASE_MIGRATIONS.map((item) => item.version),
    );
    database.close();
  });

  test("rolls back a failed migration", () => {
    const database = new Database(":memory:", { strict: true });
    const failingMigration: PolicyDatabaseMigration = {
      version: 99,
      name: "intentional failure",
      apply(target) {
        target.exec("CREATE TABLE unfinished (id INTEGER PRIMARY KEY);");
        throw new Error("migration failed");
      },
    };

    expect(() => applyPolicyDatabaseMigrations(database, [failingMigration])).toThrow(
      "migration failed",
    );
    const migrationCount = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
      .get()?.count;
    expect(migrationCount).toBe(0);
    expect(() => database.query("SELECT * FROM unfinished").all()).toThrow();
    database.close();
  });
});

function createSnapshot(id: string): PolicySnapshot {
  return {
    schemaVersion: 1,
    id,
    projectRoot: "/workspace/project",
    createdAtMs: 10,
    versions: {
      compiler: "compiler-1",
      question: "question-1",
      thresholds: "thresholds-1",
      model: "jev-1.13.0",
    },
    sources: [],
    rules: [],
  };
}

function createAudit(snapshot: PolicySnapshot): PolicyAuditRecord {
  return {
    phase: "decision",
    actionId: "action-1",
    projectRoot: snapshot.projectRoot,
    snapshotId: snapshot.id,
    occurredAtMs: 11,
    operation: "write",
    interception: "precise",
    targetSummaries: ["path:src/index.ts"],
    effect: "prompt",
    evaluatorId: "typesafe",
    evidenceSource: "semantic",
    ruleIds: ["rule-1"],
  };
}
