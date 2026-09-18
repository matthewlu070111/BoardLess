import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";

function values(input: unknown[]): SQLInputValue[] {
  return input.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return value as SQLInputValue;
  });
}

class LocalStatement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly parameters: unknown[] = []) {}

  bind(...parameters: unknown[]) {
    return new LocalStatement(this.database, this.sql, parameters);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...values(this.parameters)) as T | undefined) ?? null;
  }

  async all<T>() {
    const results = this.database.prepare(this.sql).all(...values(this.parameters)) as T[];
    return { success: true, results, meta: { duration: 0 } };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const result = this.database.prepare(this.sql).run(...values(this.parameters));
    return {
      success: true,
      meta: { duration: 0, changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      results: [],
    };
  }
}

export class LocalDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }

  prepare(sql: string) {
    return new LocalStatement(this.sqlite, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => (statement as unknown as LocalStatement).execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  migrate(directory: string) {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS _boardless_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = this.sqlite.prepare("SELECT 1 FROM _boardless_migrations WHERE name = ?");
    const record = this.sqlite.prepare("INSERT INTO _boardless_migrations (name, applied_at) VALUES (?, ?)");
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
      if (applied.get(name)) continue;
      const sql = readFileSync(join(directory, name), "utf8");
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.sqlite.exec(sql);
        record.run(name, Math.floor(Date.now() / 1000));
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close() {
    this.sqlite.close();
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
