// One SQLite database per `tasks` App instance, in the instance's private
// data directory (backed up by the host with it). node:sqlite is synchronous,
// which keeps every mutation a plain transaction with no interleaving.
//
// Schema changes are forward-only migrations, each applied once in its own
// transaction and recorded in `schema_migrations`. Core migrations come first,
// then each seam's own (its `migrations.ts`) in the order `allMigrations`
// lists them. Never edit or reorder a migration that has shipped; append a
// new one.

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { attachmentMigrations } from './attachments/migrations.ts'
import { boardMigrations } from './boards/migrations.ts'
import { dependencyMigrations } from './dependencies/migrations.ts'
import { forgeMigrations } from './forge/migrations.ts'
import { inboxMigrations } from './inbox/migrations.ts'
import { mentionMigrations } from './mentions/migrations.ts'
import { openProjectMigrations } from './openproject/migrations.ts'
import { settingsMigrations } from './settings/migrations.ts'
import { versionMigrations } from './versions/migrations.ts'
import { viewMigrations } from './views/migrations.ts'
import { workflowMigrations } from './workflows/migrations.ts'

export type Db = DatabaseSync

export interface Migration {
  /** Unique, stable id: `<owner>-<nnnn>-<slug>`, e.g. `core-0001-init`. */
  id: string
  up(db: Db, env: MigrationEnv): void
}

/** Where the database being migrated lives, for a migration that moves data out of it. */
export interface MigrationEnv {
  /** The instance's data directory; absent for a database that is not a file (a test's `:memory:`). */
  dataDir?: string
}

export const coreMigrations: Migration[] = [
  {
    id: 'core-0001-init',
    up(db) {
      db.exec(`
        CREATE TABLE project_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO project_meta (key, value) VALUES ('next_number', '1');

        CREATE TABLE status (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          category TEXT NOT NULL CHECK (category IN ('todo', 'in_progress', 'done')),
          color TEXT,
          position INTEGER NOT NULL
        );
        INSERT INTO status (name, category, position) VALUES
          ('To Do', 'todo', 0),
          ('In Progress', 'in_progress', 1),
          ('In Review', 'in_progress', 2),
          ('Done', 'done', 3),
          ('Cancelled', 'done', 4);

        CREATE TABLE task (
          id INTEGER PRIMARY KEY,
          number INTEGER NOT NULL UNIQUE,
          summary TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status_id INTEGER NOT NULL REFERENCES status (id),
          type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'bug', 'story', 'epic')),
          priority TEXT NOT NULL DEFAULT 'medium'
            CHECK (priority IN ('lowest', 'low', 'medium', 'high', 'highest')),
          assignee_kind TEXT CHECK (assignee_kind IN ('agent', 'person')),
          assignee_id TEXT,
          assignee_name TEXT,
          reporter_kind TEXT NOT NULL CHECK (reporter_kind IN ('agent', 'person')),
          reporter_name TEXT NOT NULL,
          parent_id INTEGER REFERENCES task (id) ON DELETE CASCADE,
          rank TEXT NOT NULL,
          start_date TEXT,
          end_date TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((start_date IS NULL) = (end_date IS NULL)),
          CHECK (start_date IS NULL OR end_date >= start_date),
          CHECK ((assignee_kind IS NULL) = (assignee_name IS NULL))
        );
        CREATE INDEX task_parent ON task (parent_id);
        CREATE INDEX task_rank ON task (rank);
        CREATE INDEX task_status ON task (status_id);

        CREATE TABLE task_label (
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          PRIMARY KEY (task_id, label)
        );
        CREATE INDEX task_label_label ON task_label (label);

        CREATE TABLE comment (
          id INTEGER PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'person')),
          author_name TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX comment_task ON comment (task_id);

        CREATE TABLE activity (
          id INTEGER PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'person')),
          actor_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          field TEXT,
          from_value TEXT,
          to_value TEXT,
          at TEXT NOT NULL
        );
        CREATE INDEX activity_task ON activity (task_id);

        -- Substring search over summary and description. The key is matched
        -- separately (by number), so it is not indexed here.
        CREATE VIRTUAL TABLE task_fts USING fts5 (
          summary, description, content = 'task', content_rowid = 'id', tokenize = 'trigram'
        );
        CREATE TRIGGER task_fts_insert AFTER INSERT ON task BEGIN
          INSERT INTO task_fts (rowid, summary, description) VALUES (new.id, new.summary, new.description);
        END;
        CREATE TRIGGER task_fts_delete AFTER DELETE ON task BEGIN
          INSERT INTO task_fts (task_fts, rowid, summary, description)
            VALUES ('delete', old.id, old.summary, old.description);
        END;
        CREATE TRIGGER task_fts_update AFTER UPDATE OF summary, description ON task BEGIN
          INSERT INTO task_fts (task_fts, rowid, summary, description)
            VALUES ('delete', old.id, old.summary, old.description);
          INSERT INTO task_fts (rowid, summary, description) VALUES (new.id, new.summary, new.description);
        END;
      `)
    },
  },
]

/** Every migration, in application order. */
export function allMigrations(): Migration[] {
  return [
    ...coreMigrations,
    ...workflowMigrations,
    ...inboxMigrations,
    ...dependencyMigrations,
    ...viewMigrations,
    ...attachmentMigrations,
    ...mentionMigrations,
    ...settingsMigrations,
    ...versionMigrations,
    ...openProjectMigrations,
    ...forgeMigrations,
    ...boardMigrations,
  ]
}

/** Apply every migration not yet recorded, each in its own transaction. */
export function migrate(db: Db, migrations: Migration[] = allMigrations(), env: MigrationEnv = {}): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((row) => row.id),
  )
  const ran: string[] = []
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue
    }
    transaction(db, () => {
      migration.up(db, env)
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      )
    })
    ran.push(migration.id)
  }
  return ran
}

/** Run `fn` in a transaction: committed when it returns, rolled back when it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Open (or create) a database file and bring it to the current schema. */
export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db, allMigrations(), { dataDir: path.dirname(file) })
  return db
}

// Open connections by instance id, with the migration ids each was last
// brought up to. On globalThis so a hot-reloaded server module reuses the
// connection instead of opening a second one on the file — which is also why
// the migration list is re-checked on every lookup: a deploy that adds a
// migration reloads this module but keeps the open connection.
const globalForDb = globalThis as unknown as {
  __taskPipelinesDbs?: Map<string, { db: Db; migratedWith: string }>
}

function connections(): Map<string, { db: Db; migratedWith: string }> {
  globalForDb.__taskPipelinesDbs ??= new Map()
  return globalForDb.__taskPipelinesDbs
}

function migrationSignature(): string {
  return allMigrations()
    .map((migration) => migration.id)
    .join('\n')
}

/** The database of one App instance, opened and migrated on first use and whenever new migrations ship. */
export function instanceDb(instanceId: string, dataDir: string): Db {
  const signature = migrationSignature()
  const open = connections().get(instanceId)
  if (open) {
    if (open.migratedWith !== signature) {
      migrate(open.db, allMigrations(), { dataDir })
      open.migratedWith = signature
    }
    return open.db
  }
  const db = openDatabase(path.join(dataDir, 'tasks.db'))
  connections().set(instanceId, { db, migratedWith: signature })
  return db
}

/** Close one instance's database, e.g. on unload or removal. */
export function closeInstanceDb(instanceId: string): void {
  const open = connections().get(instanceId)
  if (open) {
    connections().delete(instanceId)
    open.db.close()
  }
}
