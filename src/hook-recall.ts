// UserPromptSubmit hook for Claude Code.
// Reads {prompt} from stdin, runs FTS5 search against ~/.taw-mem/memory.db,
// emits a <taw-mem-context> block to stdout if relevant memories found.
// Silent on no-match, error, or short prompts. Never blocks the prompt.
//
// Designed to be FAST (<200ms cold). No Xenova embedding here — that's
// reserved for the MCP recall tool when the model wants semantic search.

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DB_PATH = process.env.TAW_MEM_DB ?? join(homedir(), ".taw-mem", "memory.db");
const MIN_PROMPT_WORDS = 4;
const MAX_RESULTS = 3;
const SNIPPET_LEN = 220;
// sqlite FTS5 bm25 rank: more negative = better. -0.5 is a soft floor;
// real matches usually score < -1.0. Tune via TAW_MEM_HOOK_THRESHOLD env.
const RANK_THRESHOLD = Number(process.env.TAW_MEM_HOOK_THRESHOLD ?? -0.5);

interface FtsHit {
  id: number;
  rank: number;
  content: string;
  tags: string;
  source: string | null;
  created_at: number;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function tokenize(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function snippet(content: string, max: number): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function formatHit(h: FtsHit): string {
  let tagsArr: string[] = [];
  try {
    tagsArr = JSON.parse(h.tags ?? "[]");
  } catch {}
  const tagStr = tagsArr.length ? ` ${tagsArr.join(",")}` : "";
  const date = new Date(h.created_at).toISOString().slice(0, 10);
  return `[#${h.id}${tagStr} · ${date}]\n${snippet(h.content, SNIPPET_LEN)}`;
}

async function main() {
  const raw = await readStdin();
  const input = safeJsonParse(raw);
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) return;

  const wordCount = prompt.split(/\s+/).length;
  if (wordCount < MIN_PROMPT_WORDS) return;

  if (!existsSync(DB_PATH)) return;

  const tokens = tokenize(prompt);
  if (tokens.length === 0) return;

  let db: Database.Database;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    return;
  }

  let hits: FtsHit[] = [];
  try {
    const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const rows = db
      .prepare(
        `SELECT m.id, fts.rank, m.content, m.tags, m.source, m.created_at
         FROM memories_fts fts
         JOIN memories m ON m.id = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`
      )
      .all(ftsQuery, MAX_RESULTS) as FtsHit[];
    hits = rows.filter((r) => r.rank < RANK_THRESHOLD);
  } catch {
    db.close();
    return;
  }

  db.close();

  if (hits.length === 0) return;

  const lines: string[] = [];
  lines.push("<taw-mem-context>");
  lines.push(
    `Possibly relevant from your memory store (${hits.length} hit${
      hits.length > 1 ? "s" : ""
    } via FTS keyword match):`
  );
  lines.push("");
  for (const h of hits) {
    lines.push(formatHit(h));
    lines.push("");
  }
  lines.push(
    "If a hit looks useful, fetch full content via mcp__taw-mem__get(id). For semantic / cross-lingual lookup beyond keyword overlap, use mcp__taw-mem__recall(query)."
  );
  lines.push("</taw-mem-context>");

  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`[taw-mem hook] ${err?.message ?? err}\n`);
  // exit 0 — never block prompt on error
});
