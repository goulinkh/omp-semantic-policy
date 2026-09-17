import type { Database } from "bun:sqlite";

export interface PolicyDatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly apply: (database: Database) => void;
}

export const POLICY_DATABASE_MIGRATIONS: readonly PolicyDatabaseMigration[] = [
  {
    version: 1,
    name: "initial policy storage",
    apply(database) {
      database.exec(`
        CREATE TABLE projects (
          project_root TEXT PRIMARY KEY,
          active_snapshot_id TEXT,
          stale INTEGER NOT NULL DEFAULT 1 CHECK (stale IN (0, 1)),
          last_seen_at_ms INTEGER NOT NULL
        );
        CREATE TABLE snapshots (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (project_root) REFERENCES projects(project_root) ON DELETE CASCADE
        );
        CREATE INDEX snapshots_project_created
          ON snapshots(project_root, created_at_ms DESC);
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE audits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_root TEXT NOT NULL,
          action_id TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL,
          phase TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX audits_project_occurred
          ON audits(project_root, occurred_at_ms DESC);
      `);
    },
  },
];

/** Apply each schema change atomically and record it only after success. */
export function applyPolicyDatabaseMigrations(
  database: Database,
  migrations: readonly PolicyDatabaseMigration[] = POLICY_DATABASE_MIGRATIONS,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const appliedRows = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations")
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
  );

  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (applied.has(migration.version)) {
      continue;
    }
    database.transaction(() => {
      migration.apply(database);
      insertMigration.run(migration.version, migration.name, Date.now());
    })();
  }
}
