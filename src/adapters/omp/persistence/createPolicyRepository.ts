import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PolicyAuditRecord, PolicySnapshot } from "../../../policy/index.js";
import { applyPolicyDatabaseMigrations } from "./migrations.js";

const REMOTE_CONSENT_KEY = "semantic_remote_consent";

export interface StoredProject {
  readonly projectRoot: string;
  readonly activeSnapshotId?: string;
  readonly stale: boolean;
  readonly lastSeenAtMs: number;
}

export interface PolicyRepository {
  touchProject(projectRoot: string, occurredAtMs?: number): void;
  getProject(projectRoot: string): StoredProject | undefined;
  saveSnapshot(snapshot: PolicySnapshot): void;
  getActiveSnapshot(projectRoot: string): PolicySnapshot | undefined;
  markStale(projectRoot: string): void;
  getRemoteConsent(): boolean | undefined;
  setRemoteConsent(consented: boolean, occurredAtMs?: number): void;
  addLinkedSource(projectRoot: string, sourcePath: string, occurredAtMs?: number): void;
  listLinkedSources(projectRoot: string): readonly string[];
  appendAudit(record: PolicyAuditRecord): void;
  listAudits(projectRoot: string, limit?: number): readonly PolicyAuditRecord[];
  close(): void;
}

export async function createPolicyRepository(databasePath: string): Promise<PolicyRepository> {
  if (databasePath !== ":memory:") {
    const directory = dirname(databasePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const database = new Database(databasePath, { create: true, strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  applyPolicyDatabaseMigrations(database);

  if (databasePath !== ":memory:") {
    await chmod(databasePath, 0o600);
  }

  const touchProject = database.prepare(`
    INSERT INTO projects (project_root, last_seen_at_ms)
    VALUES (?, ?)
    ON CONFLICT(project_root) DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms
  `);
  const getProject = database.prepare<StoredProjectRow, [string]>(`
    SELECT project_root, active_snapshot_id, stale, last_seen_at_ms
    FROM projects WHERE project_root = ?
  `);
  const insertSnapshot = database.prepare(`
    INSERT OR IGNORE INTO snapshots (id, project_root, created_at_ms, payload_json)
    VALUES (?, ?, ?, ?)
  `);
  const activateSnapshot = database.prepare(`
    UPDATE projects SET active_snapshot_id = ?, stale = 0, last_seen_at_ms = ?
    WHERE project_root = ?
  `);
  const getActiveSnapshot = database.prepare<{ payload_json: string }, [string]>(`
    SELECT snapshots.payload_json
    FROM projects
    JOIN snapshots ON snapshots.id = projects.active_snapshot_id
    WHERE projects.project_root = ?
  `);
  const markStale = database.prepare("UPDATE projects SET stale = 1 WHERE project_root = ?");
  const getSetting = database.prepare<{ value: string }, [string]>(
    "SELECT value FROM settings WHERE key = ?",
  );
  const setSetting = database.prepare(`
    INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
  `);
  const insertLinkedSource = database.prepare(`
    INSERT INTO linked_sources (project_root, source_path, added_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(project_root, source_path) DO NOTHING
  `);
  const listLinkedSources = database.prepare<{ source_path: string }, [string]>(`
    SELECT source_path FROM linked_sources WHERE project_root = ? ORDER BY source_path ASC
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audits (project_root, action_id, occurred_at_ms, phase, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listAudits = database.prepare<{ payload_json: string }, [string]>(`
    SELECT payload_json FROM audits WHERE project_root = ? ORDER BY id ASC
  `);
  const listRecentAudits = database.prepare<{ payload_json: string }, [string, number]>(`
    SELECT payload_json FROM audits WHERE project_root = ? ORDER BY id DESC LIMIT ?
  `);

  return {
    touchProject(projectRoot, occurredAtMs = Date.now()) {
      touchProject.run(projectRoot, occurredAtMs);
    },
    getProject(projectRoot) {
      const row = getProject.get(projectRoot);
      if (row === null) {
        return undefined;
      }
      return {
        projectRoot: row.project_root,
        ...(row.active_snapshot_id === null ? {} : { activeSnapshotId: row.active_snapshot_id }),
        stale: row.stale === 1,
        lastSeenAtMs: row.last_seen_at_ms,
      };
    },
    saveSnapshot(snapshot) {
      database.transaction(() => {
        touchProject.run(snapshot.projectRoot, snapshot.createdAtMs);
        insertSnapshot.run(
          snapshot.id,
          snapshot.projectRoot,
          snapshot.createdAtMs,
          JSON.stringify(snapshot),
        );
        activateSnapshot.run(snapshot.id, snapshot.createdAtMs, snapshot.projectRoot);
      })();
    },
    getActiveSnapshot(projectRoot) {
      const row = getActiveSnapshot.get(projectRoot);
      if (row === null) {
        return undefined;
      }
      return parseSnapshot(row.payload_json, projectRoot);
    },
    markStale(projectRoot) {
      markStale.run(projectRoot);
    },
    getRemoteConsent() {
      const row = getSetting.get(REMOTE_CONSENT_KEY);
      return row === null ? undefined : row.value === "true";
    },
    setRemoteConsent(consented, occurredAtMs = Date.now()) {
      setSetting.run(REMOTE_CONSENT_KEY, String(consented), occurredAtMs);
    },
    addLinkedSource(projectRoot, sourcePath, occurredAtMs = Date.now()) {
      database.transaction(() => {
        touchProject.run(projectRoot, occurredAtMs);
        insertLinkedSource.run(projectRoot, sourcePath, occurredAtMs);
      })();
    },
    listLinkedSources(projectRoot) {
      return listLinkedSources.all(projectRoot).map((row) => row.source_path);
    },
    appendAudit(record) {
      insertAudit.run(
        record.projectRoot,
        record.actionId,
        record.occurredAtMs,
        record.phase,
        JSON.stringify(record),
      );
    },
    listAudits(projectRoot, limit) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new RangeError("Audit limit must be a positive safe integer.");
      }
      const rows =
        limit === undefined
          ? listAudits.all(projectRoot)
          : listRecentAudits.all(projectRoot, limit).reverse();
      return rows.map((row) => JSON.parse(row.payload_json) as PolicyAuditRecord);
    },
    close() {
      database.close();
    },
  };
}

interface StoredProjectRow {
  readonly project_root: string;
  readonly active_snapshot_id: string | null;
  readonly stale: number;
  readonly last_seen_at_ms: number;
}

function parseSnapshot(payload: string, projectRoot: string): PolicySnapshot {
  const parsed = JSON.parse(payload) as Partial<PolicySnapshot>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.projectRoot !== projectRoot ||
    typeof parsed.id !== "string"
  ) {
    throw new Error(`Invalid policy snapshot for ${projectRoot}`);
  }
  return parsed as PolicySnapshot;
}
