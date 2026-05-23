import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemoryRow {
  id: number;
  content: string;
  source: string | null;
  project: string | null;
  tags: string[];
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  superseded_by: number | null;
  kind: string;
  quality_score: number;
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
      project TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      superseded_by INTEGER,
      kind TEXT NOT NULL DEFAULT 'fact',
      quality_score REAL NOT NULL DEFAULT 0.5
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

  const cols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  const currentCols = new Set(cols.map((c) => c.name));
  const migrations: [string, string][] = [
    ["project", "ALTER TABLE memories ADD COLUMN project TEXT"],
    ["updated_at", "ALTER TABLE memories ADD COLUMN updated_at INTEGER"],
    ["last_accessed_at", "ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER"],
    ["access_count", "ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0"],
    ["superseded_by", "ALTER TABLE memories ADD COLUMN superseded_by INTEGER"],
    ["kind", "ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'"],
    ["quality_score", "ALTER TABLE memories ADD COLUMN quality_score REAL NOT NULL DEFAULT 0.5"],
  ];
  for (const [name, sql] of migrations) {
    if (!currentCols.has(name)) db.exec(sql);
  }
  db.exec(`
    UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_project_lower ON memories(lower(project));
    CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
  `);

  _db = db;
  return db;
}

export function rowToMemory(r: any): MemoryRow {
  return {
    id: r.id,
    content: r.content,
    source: r.source,
    project: r.project ?? null,
    tags: JSON.parse(r.tags ?? "[]"),
    created_at: r.created_at,
    updated_at: r.updated_at ?? r.created_at,
    last_accessed_at: r.last_accessed_at ?? null,
    access_count: r.access_count ?? 0,
    superseded_by: r.superseded_by ?? null,
    kind: r.kind ?? "fact",
    quality_score: r.quality_score ?? 0.5,
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
  project?: string | null;
  tags: string[];
  embedding: number[];
  kind?: string;
  quality_score?: number;
}): MemoryRow {
  const db = getDb();
  const created_at = Date.now();
  const tagsJson = JSON.stringify(args.tags);
  const project = args.project?.trim() || null;
  const kind = args.kind?.trim() || "fact";
  const quality = Math.max(0, Math.min(1, args.quality_score ?? 0.5));

  const insert = db.prepare(
    `INSERT INTO memories (content, source, project, tags, created_at, updated_at, kind, quality_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(
    args.content,
    args.source ?? null,
    project,
    tagsJson,
    created_at,
    created_at,
    kind,
    quality
  );
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
    project,
    tags: args.tags,
    created_at,
    updated_at: created_at,
    last_accessed_at: null,
    access_count: 0,
    superseded_by: null,
    kind,
    quality_score: quality,
  };
}

export function getMemory(id: number): MemoryRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
  return row ? rowToMemory(row) : null;
}

export function listRecentMemories(limit: number, project?: string | null): MemoryRow[] {
  const db = getDb();
  if (project) {
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE project IS NOT NULL AND lower(project) = lower(?)
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(project, limit) as any[];
    return rows.map(rowToMemory);
  }
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

export function vectorSearch(
  embedding: number[],
  limit: number,
  project?: string | null
): { id: number; distance: number }[] {
  const db = getDb();
  const vectorLimit = project ? Math.max(limit * 10, 100) : limit;
  const hits = db
    .prepare(
      `SELECT rowid AS id, distance FROM memories_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(embeddingToBlob(embedding), vectorLimit) as { id: number; distance: number }[];
  if (hits.length === 0) return [];

  const placeholders = hits.map(() => "?").join(",");
  const rows = (project
    ? db
        .prepare(
          `SELECT id FROM memories
           WHERE id IN (${placeholders})
             AND project IS NOT NULL
             AND lower(project) = lower(?)
             AND superseded_by IS NULL`
        )
        .all(...hits.map((h) => h.id), project)
    : db
        .prepare(
          `SELECT id FROM memories
           WHERE id IN (${placeholders}) AND superseded_by IS NULL`
        )
        .all(...hits.map((h) => h.id))) as { id: number }[];
  const allowed = new Set(rows.map((r) => r.id));
  return hits.filter((h) => allowed.has(h.id)).slice(0, limit);
}

export function ftsSearch(
  query: string,
  limit: number,
  project?: string | null
): { id: number; rank: number }[] {
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
    if (project) {
      const rows = db
        .prepare(
          `SELECT memories_fts.rowid AS id, rank
           FROM memories_fts
           JOIN memories ON memories.id = memories_fts.rowid
           WHERE memories_fts MATCH ?
             AND memories.project IS NOT NULL
             AND lower(memories.project) = lower(?)
             AND memories.superseded_by IS NULL
           ORDER BY rank LIMIT ?`
        )
        .all(ftsQuery, project, limit) as { id: number; rank: number }[];
      return rows;
    }
    const rows = db
      .prepare(
        `SELECT memories_fts.rowid AS id, rank
         FROM memories_fts
         JOIN memories ON memories.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND memories.superseded_by IS NULL
         ORDER BY rank LIMIT ?`
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

export function countMemories(project?: string | null): number {
  const db = getDb();
  if (project) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE project IS NOT NULL AND lower(project) = lower(?)`
      )
      .get(project) as { n: number };
    return row.n;
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
  return row.n;
}

function canonicalText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function findDuplicateMemory(content: string, project?: string | null): MemoryRow | null {
  const db = getDb();
  const canonical = canonicalText(content);
  const rows = project
    ? (db
        .prepare(
          `SELECT * FROM memories
           WHERE project IS NOT NULL AND lower(project) = lower(?) AND superseded_by IS NULL
           ORDER BY created_at DESC`
        )
        .all(project) as any[])
    : (db
        .prepare(`SELECT * FROM memories WHERE superseded_by IS NULL ORDER BY created_at DESC`)
        .all() as any[]);
  const found = rows.find((r) => canonicalText(r.content) === canonical);
  return found ? rowToMemory(found) : null;
}

export function touchMemories(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`
  );
  const tx = db.transaction((memoryIds: number[]) => {
    for (const id of memoryIds) stmt.run(now, id);
  });
  tx(ids);
}

export interface MemoryHealth {
  total: number;
  active: number;
  superseded: number;
  missing_project: number;
  missing_source: number;
  exact_duplicates: { ids: number[]; content_preview: string }[];
  project_variants: { normalized: string; variants: string[]; count: number }[];
  suspicious_secret_like: { id: number; reason: string; content_preview: string }[];
  noisy_long: { id: number; chars: number; content_preview: string }[];
  stale_unaccessed: number;
  avg_chars: number;
  max_chars: number;
  tag_counts: Record<string, number>;
  recommendations: string[];
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [
    /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{12,}/i,
    "assignment-shaped secret",
  ],
  [/\bBearer\s+[A-Za-z0-9_\-./+=]{16,}/i, "bearer token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\btmem_[a-f0-9]{32,}\b/i, "taw-mem-cloud api key"],
];

export function findSecretLike(content: string): string | null {
  for (const [re, reason] of SECRET_PATTERNS) {
    if (re.test(content)) return reason;
  }
  return null;
}

function preview(content: string): string {
  return content.replace(/\s+/g, " ").slice(0, 180);
}

export function getMemoryHealth(project?: string | null): MemoryHealth {
  const db = getDb();
  const rows = (project
    ? db
        .prepare(
          `SELECT * FROM memories
           WHERE project IS NOT NULL AND lower(project) = lower(?)
           ORDER BY created_at DESC`
        )
        .all(project)
    : db.prepare(`SELECT * FROM memories ORDER BY created_at DESC`).all()) as any[];
  const memories = rows.map(rowToMemory);
  const active = memories.filter((m) => m.superseded_by == null);
  const totalChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  const maxChars = memories.reduce((max, m) => Math.max(max, m.content.length), 0);

  const duplicateGroups = new Map<string, MemoryRow[]>();
  const projectGroups = new Map<string, Set<string>>();
  const tagCounts: Record<string, number> = {};
  const suspicious: MemoryHealth["suspicious_secret_like"] = [];
  const noisyLong: MemoryHealth["noisy_long"] = [];
  const staleCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let stale = 0;

  for (const memory of memories) {
    const key = canonicalText(memory.content);
    const dupes = duplicateGroups.get(key) ?? [];
    dupes.push(memory);
    duplicateGroups.set(key, dupes);
    if (memory.project) {
      const normalized = memory.project.toLowerCase();
      const variants = projectGroups.get(normalized) ?? new Set<string>();
      variants.add(memory.project);
      projectGroups.set(normalized, variants);
    }
    for (const tag of memory.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    const secretReason = findSecretLike(memory.content);
    if (secretReason) {
      suspicious.push({
        id: memory.id,
        reason: secretReason,
        content_preview: preview(memory.content),
      });
    }
    if (memory.content.length > 1200) {
      noisyLong.push({
        id: memory.id,
        chars: memory.content.length,
        content_preview: preview(memory.content),
      });
    }
    if (memory.superseded_by == null && memory.access_count === 0 && memory.created_at < staleCutoff) {
      stale += 1;
    }
  }

  const exact_duplicates = [...duplicateGroups.values()]
    .filter((group) => group.length > 1)
    .slice(0, 20)
    .map((group) => ({
      ids: group.map((m) => m.id),
      content_preview: preview(group[0]!.content),
    }));

  const project_variants = [...projectGroups.entries()]
    .map(([normalized, variants]) => ({
      normalized,
      variants: [...variants].sort(),
      count: memories.filter((m) => m.project?.toLowerCase() === normalized).length,
    }))
    .filter((group) => group.variants.length > 1);

  const recommendations: string[] = [];
  if (exact_duplicates.length) recommendations.push("Deduplicate exact repeated memories before adding new ones.");
  if (project_variants.length) recommendations.push("Normalize project names at recall/list time; prefer one canonical casing.");
  if (suspicious.length) recommendations.push("Review secret-like memories and forget any raw credentials.");
  if (noisyLong.length) recommendations.push("Compact long/noisy memories into project summaries.");
  if (active.length > 30) recommendations.push("Run compact_project periodically for active projects with many small memories.");

  return {
    total: memories.length,
    active: active.length,
    superseded: memories.length - active.length,
    missing_project: memories.filter((m) => !m.project).length,
    missing_source: memories.filter((m) => !m.source).length,
    exact_duplicates,
    project_variants,
    suspicious_secret_like: suspicious.slice(0, 20),
    noisy_long: noisyLong.slice(0, 20),
    stale_unaccessed: stale,
    avg_chars: memories.length ? Math.round(totalChars / memories.length) : 0,
    max_chars: maxChars,
    tag_counts: tagCounts,
    recommendations,
  };
}

export function listCompactionCandidates(project: string, limit: number): MemoryRow[] {
  const db = getDb();
  return (db
    .prepare(
      `SELECT * FROM memories
       WHERE project IS NOT NULL
         AND lower(project) = lower(?)
         AND superseded_by IS NULL
         AND kind != 'summary'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(project, limit) as any[]).map(rowToMemory);
}

export function markSuperseded(ids: number[], supersededBy: number): void {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?`);
  const tx = db.transaction((memoryIds: number[]) => {
    for (const id of memoryIds) stmt.run(supersededBy, now, id);
  });
  tx(ids);
}
