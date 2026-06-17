import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

type SqliteRow = Record<string, unknown>;

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  close(): void;
  prepare?(sql: string): SqliteStatement;
  query?(sql: string): SqliteStatement;
}

const require = createRequire(import.meta.url);

function loadDatabaseCtor(): new (databasePath: string, options?: Record<string, unknown>) => SqliteDatabase {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return require("bun:sqlite").Database;
  }

  return require("node:sqlite").DatabaseSync;
}

export class GoalDb {
  private readonly db: SqliteDatabase;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const Database = loadDatabaseCtor();
    this.db = new Database(databasePath, { create: true });
    this.exec("PRAGMA foreign_keys = ON;");
    this.exec("PRAGMA busy_timeout = 5000;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const statement = this.db.prepare?.(sql) ?? this.db.query?.(sql);
    if (!statement) {
      throw new Error("SQLite runtime does not expose prepare/query.");
    }
    return statement;
  }

  get(sql: string, ...params: unknown[]): SqliteRow | undefined {
    return this.prepare(sql).get(...params);
  }

  all(sql: string, ...params: unknown[]): SqliteRow[] {
    return this.prepare(sql).all(...params);
  }

  run(sql: string, ...params: unknown[]): unknown {
    return this.prepare(sql).run(...params);
  }

  close(): void {
    this.db.close();
  }
}
