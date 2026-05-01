import {
  insertMemory,
  getMemory,
  listRecentMemories,
  deleteMemory,
  vectorSearch,
  ftsSearch,
  fetchMemoriesByIds,
  countMemories,
  type MemoryRow,
} from "./db.js";
import { embed } from "./embed.js";
import { autoTag } from "./tags.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
}

interface FormattedMemory {
  id: number;
  content: string;
  source: string | null;
  tags: string[];
  created_at: string;
}

function fmt(m: MemoryRow): FormattedMemory {
  return {
    id: m.id,
    content: m.content,
    source: m.source,
    tags: m.tags,
    created_at: new Date(m.created_at).toISOString(),
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "remember",
    description:
      "Store a memory. Auto-embeds via local model and auto-tags (code/error/url/todo/cmd). Returns the stored memory with id.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (text, code, note, etc.)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional manual tags. Merged with auto-detected tags.",
        },
        source: {
          type: "string",
          description: "Optional source label (e.g. 'claude-code', 'commit:abc123', 'url:...')",
        },
      },
      required: ["content"],
    },
    handler: async (args: { content: string; tags?: string[]; source?: string }) => {
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("content is required and must be non-empty");

      const auto = autoTag(content);
      const manual = (args.tags ?? []).filter((t) => typeof t === "string" && t.length > 0);
      const tags = [...new Set([...auto, ...manual])];

      const vec = await embed(content);
      const m = insertMemory({
        content,
        source: args.source ?? null,
        tags,
        embedding: vec,
      });
      return { ok: true, memory: fmt(m) };
    },
  },

  {
    name: "recall",
    description:
      "Hybrid search (vector similarity + keyword FTS5). Returns top-k memories ranked by Reciprocal Rank Fusion. Optional filter by tag.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword query" },
        limit: { type: "number", description: "Max results (default 5, max 50)" },
        filter_tag: { type: "string", description: "Only return memories with this tag" },
      },
      required: ["query"],
    },
    handler: async (args: { query: string; limit?: number; filter_tag?: string }) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required and must be non-empty");
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 50);
      const fanout = limit * 4;

      const qvec = await embed(query);
      const vecHits = vectorSearch(qvec, fanout);
      const ftsHits = ftsSearch(query, fanout);

      // Reciprocal Rank Fusion (k=60)
      const RRF_K = 60;
      const scores = new Map<number, { score: number; vec_rank?: number; fts_rank?: number; distance?: number }>();
      vecHits.forEach((h, i) => {
        const cur = scores.get(h.id) ?? { score: 0 };
        cur.score += 1 / (RRF_K + i + 1);
        cur.vec_rank = i + 1;
        cur.distance = h.distance;
        scores.set(h.id, cur);
      });
      ftsHits.forEach((h, i) => {
        const cur = scores.get(h.id) ?? { score: 0 };
        cur.score += 1 / (RRF_K + i + 1);
        cur.fts_rank = i + 1;
        scores.set(h.id, cur);
      });

      const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
      const ids = ranked.map(([id]) => id);
      const rowMap = fetchMemoriesByIds(ids);

      let results = ranked
        .map(([id, meta]) => {
          const m = rowMap.get(id);
          if (!m) return null;
          return {
            ...fmt(m),
            _score: Number(meta.score.toFixed(4)),
            _vec_rank: meta.vec_rank ?? null,
            _fts_rank: meta.fts_rank ?? null,
            _distance: meta.distance != null ? Number(meta.distance.toFixed(4)) : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (args.filter_tag) {
        const tag = args.filter_tag.toLowerCase();
        results = results.filter((r) =>
          (r.tags as string[]).some((t) => t.toLowerCase() === tag)
        );
      }

      return { ok: true, count: results.length, results: results.slice(0, limit) };
    },
  },

  {
    name: "get",
    description: "Fetch one memory by its id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory id" },
      },
      required: ["id"],
    },
    handler: async (args: { id: number }) => {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error("id must be a number");
      const m = getMemory(id);
      if (!m) return { ok: false, error: `no memory with id=${id}` };
      return { ok: true, memory: fmt(m) };
    },
  },

  {
    name: "list_recent",
    description: "List the most recently added memories (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 20, max 200)" },
      },
    },
    handler: async (args: { limit?: number }) => {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
      const rows = listRecentMemories(limit);
      return {
        ok: true,
        total: countMemories(),
        count: rows.length,
        results: rows.map(fmt),
      };
    },
  },

  {
    name: "forget",
    description: "Permanently delete a memory by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Memory id to delete" },
      },
      required: ["id"],
    },
    handler: async (args: { id: number }) => {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error("id must be a number");
      const ok = deleteMemory(id);
      return { ok, error: ok ? null : `no memory with id=${id}` };
    },
  },
];

export const TOOL_INDEX: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
