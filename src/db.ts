import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemoryRow {
  id: number;
  content: string;
  source: string | null;
  tags: string[];
  created_at: number;
}

const DB_DIR = join(homedir(), ".taw-mem");
const DB_PATH = process.env.TAW_MEM_DB ?? join(DB_DIR, "memory.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      embedding float[384]
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  _db = db;
  return db;
}

export function rowToMemory(r: any): MemoryRow {
  return {
    id: r.id,
    content: r.content,
    source: r.source,
    tags: JSON.parse(r.tags ?? "[]"),
    created_at: r.created_at,
  };
}

export function embeddingToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i]!, i * 4);
  }
  return buf;
}

export function insertMemory(args: {
  content: string;
  source?: string | null;
  tags: string[];
  embedding: number[];
}): MemoryRow {
  const db = getDb();
  const created_at = Date.now();
  const tagsJson = JSON.stringify(args.tags);

  const insert = db.prepare(
    `INSERT INTO memories (content, source, tags, created_at) VALUES (?, ?, ?, ?)`
  );
  const result = insert.run(args.content, args.source ?? null, tagsJson, created_at);
  const id = Number(result.lastInsertRowid);

  // sqlite-vec vec0 requires bigint rowid bindings
  db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`).run(
    BigInt(id),
    embeddingToBlob(args.embedding)
  );

  db.prepare(`INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)`).run(
    BigInt(id),
    args.content,
    args.tags.join(" ")
  );

  return {
    id,
    content: args.content,
    source: args.source ?? null,
    tags: args.tags,
    created_at,
  };
}

export function getMemory(id: number): MemoryRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
  return row ? rowToMemory(row) : null;
}

export function listRecentMemories(limit: number): MemoryRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as any[];
  return rows.map(rowToMemory);
}

export function deleteMemory(id: number): boolean {
  const db = getDb();
  const tx = db.transaction((id: number) => {
    db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(BigInt(id));
    db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(BigInt(id));
    const r = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return r.changes > 0;
  });
  return tx(id);
}

export function vectorSearch(embedding: number[], limit: number): { id: number; distance: number }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rowid AS id, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(embeddingToBlob(embedding), limit) as { id: number; distance: number }[];
  return rows;
}

export function ftsSearch(query: string, limit: number): { id: number; rank: number }[] {
  const db = getDb();
  // Tokenize: keep alphanumerics and underscores per token, drop fts5 operators.
  // OR-join so recall is generous; ranking re-fused via RRF in the tools layer.
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT rowid AS id, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit) as { id: number; rank: number }[];
    return rows;
  } catch {
    return [];
  }
}

export function fetchMemoriesByIds(ids: number[]): Map<number, MemoryRow> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...ids) as any[];
  const map = new Map<number, MemoryRow>();
  for (const r of rows) {
    const m = rowToMemory(r);
    map.set(m.id, m);
  }
  return map;
}

export function countMemories(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
  return row.n;
}
