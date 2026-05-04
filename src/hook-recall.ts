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
const MIN_MEANINGFUL_TOKENS = 3;
const TOKEN_MIN_LEN = 4;
const MAX_RESULTS = 3;
const SNIPPET_LEN = 220;
// sqlite FTS5 bm25 rank: more negative = better. -1.0 = decent match,
// -2.0 = strong. Tune via TAW_MEM_HOOK_THRESHOLD env.
const RANK_THRESHOLD = Number(process.env.TAW_MEM_HOOK_THRESHOLD ?? -1.0);

// Common VN + EN stopwords (diacritics already stripped). These get filtered
// out before FTS so prompts like "khi nào nó query" don't trigger noise hits
// just because "khi" or "nao" overlap memory content.
const STOPWORDS = new Set([
  // VN
  "la", "co", "khong", "duoc", "the", "sao", "nhi", "lai", "cai", "nay", "do",
  "kia", "thi", "ma", "va", "hay", "hoac", "voi", "cho", "de", "neu", "vi",
  "da", "dang", "se", "tu", "den", "trong", "ngoai", "tren", "duoi", "ben",
  "cung", "mot", "hai", "ba", "cac", "nhung", "moi", "tat", "ca", "gi", "ai",
  "dau", "nao", "bang", "qua", "toi", "chi", "nua", "roi", "con", "lam",
  "len", "xuong", "ra", "vao", "tao", "tom", "lay", "biet", "thay", "thoi",
  "luc", "khi", "tien", "quan", "phai", "muon", "can", "rang", "nen", "biet",
  "minh", "anh", "chi", "ong", "han", "tao", "chung", "boi", "qua", "lai",
  "ban", "bro", "duoi", "ngoai", "rat", "qua", "kha",
  // EN
  "the", "and", "but", "for", "are", "was", "were", "been", "have", "has",
  "had", "does", "did", "will", "would", "can", "could", "should", "may",
  "might", "must", "shall", "with", "about", "against", "between", "into",
  "through", "during", "before", "after", "above", "below", "from", "down",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "what", "which", "who", "whom", "this", "that", "these",
  "those", "they", "them", "their", "your", "yours", "ours", "mine", "his",
  "her", "hers", "its", "you", "him", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "nor", "not", "only", "own",
  "same", "than", "too", "very", "just", "now", "out", "off", "still",
  "while", "until", "because", "though", "although", "however",
]);

// If the prompt OPENS with one of these meta-question phrases, skip the
// hook entirely — user is asking about the system, not asking the system to
// recall something. Cheap heuristic; false negatives just mean "noisy hook
// fires on a meta question" — annoying but not breaking.
const META_QUESTION_PREFIXES = [
  // VN
  "khi nao", "lam sao", "lam the nao", "tai sao", "la gi", "nghia la",
  "giai thich", "the nao", "vi sao", "co phai", "co nen", "co the",
  "co bi", "co di", "no la", "tom lai", "y la", "tuc la", "co nghia",
  // EN
  "how do", "how to", "how does", "how can", "how should", "how is",
  "what is", "what are", "what does", "what do", "what about",
  "why does", "why is", "why do", "why are",
  "when does", "when is", "when do",
  "where is", "where do", "where does",
  "explain", "tell me", "can you explain", "could you",
];

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

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function tokenize(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= TOKEN_MIN_LEN);
}

function meaningfulTokens(raw: string[]): string[] {
  // Drop stopwords; comparison done on diacritic-stripped lowercase form
  // so "lại"/"Lai"/"lai" all hit the same stopword entry.
  return raw.filter((t) => !STOPWORDS.has(stripDiacritics(t)));
}

function looksLikeMetaQuestion(prompt: string): boolean {
  const norm = stripDiacritics(prompt.trim()).slice(0, 80);
  return META_QUESTION_PREFIXES.some((p) => norm.startsWith(p));
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

  if (looksLikeMetaQuestion(prompt)) return;

  if (!existsSync(DB_PATH)) return;

  const tokens = meaningfulTokens(tokenize(prompt));
  if (tokens.length < MIN_MEANINGFUL_TOKENS) return;

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
