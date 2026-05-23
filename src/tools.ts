import {
  insertMemory,
  getMemory,
  listRecentMemories,
  deleteMemory,
  vectorSearch,
  ftsSearch,
  fetchMemoriesByIds,
  countMemories,
  findDuplicateMemory,
  touchMemories,
  getMemoryHealth,
  findSecretLike,
  listCompactionCandidates,
  markSuperseded,
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
  project: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  superseded_by: number | null;
  kind: string;
  quality_score: number;
}

function fmt(m: MemoryRow): FormattedMemory {
  return {
    id: m.id,
    content: m.content,
    source: m.source,
    project: m.project,
    tags: m.tags,
    created_at: new Date(m.created_at).toISOString(),
    updated_at: new Date(m.updated_at).toISOString(),
    last_accessed_at: m.last_accessed_at ? new Date(m.last_accessed_at).toISOString() : null,
    access_count: m.access_count,
    superseded_by: m.superseded_by,
    kind: m.kind,
    quality_score: Number(m.quality_score.toFixed(2)),
  };
}

function qualityScore(content: string, project?: string): number {
  let score = 0.55;
  const chars = content.length;
  if (project?.trim()) score += 0.1;
  if (chars >= 80 && chars <= 900) score += 0.15;
  if (/\b(root cause|fixed|verified|continue from|decision|convention|deploy|port|path|commit)\b/i.test(content)) {
    score += 0.1;
  }
  if (/```[\s\S]*```/.test(content) || chars > 1600) score -= 0.15;
  if (findSecretLike(content)) score -= 0.5;
  return Math.max(0, Math.min(1, score));
}

function buildCompactionSummary(project: string, memories: MemoryRow[]): string {
  const ordered = [...memories].sort((a, b) => a.created_at - b.created_at);
  const lines = ordered.map((memory) => {
    const tags = memory.tags.length ? ` [${memory.tags.join(",")}]` : "";
    return `- #${memory.id}${tags} ${memory.content.replace(/\s+/g, " ").slice(0, 260)}`;
  });
  return [
    `Compacted memory summary for ${project}:`,
    ...lines,
    "Use this summary as the first recall target; fetch individual ids only when exact provenance is needed.",
  ].join("\n");
}

export const TOOLS: ToolDef[] = [
  {
    name: "remember",
    description:
      "Store a memory. Auto-embeds via local model and auto-tags (code/error/url/todo/cmd). Pass 'project' with the current repo/project name for scoped recall.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content (text, code, note, etc.)" },
        project: {
          type: "string",
          description: "Optional project/repo name. Strongly recommended for coding-agent memory.",
        },
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
    handler: async (args: { content: string; project?: string; tags?: string[]; source?: string }) => {
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("content is required and must be non-empty");
      if (content.length > 4000) {
        throw new Error("content is too long; store a concise durable summary instead");
      }
      const secretReason = findSecretLike(content);
      if (secretReason) {
        throw new Error(`memory looks like it contains a secret (${secretReason}); redact it before storing`);
      }
      const duplicate = findDuplicateMemory(content, args.project ?? null);
      if (duplicate) return { ok: true, deduped: true, memory: fmt(duplicate) };

      const auto = autoTag(content);
      const manual = (args.tags ?? []).filter((t) => typeof t === "string" && t.length > 0);
      const tags = [...new Set([...auto, ...manual])];

      const vec = await embed(content);
      const m = insertMemory({
        content,
        source: args.source ?? null,
        project: args.project ?? null,
        tags,
        embedding: vec,
        quality_score: qualityScore(content, args.project),
      });
      return { ok: true, memory: fmt(m) };
    },
  },

  {
    name: "recall",
    description:
      "Hybrid search (vector similarity + keyword FTS5). Returns top-k memories ranked by Reciprocal Rank Fusion. Optional filter by project or tag.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword query" },
        project: { type: "string", description: "Filter results to this project/repo only" },
        limit: { type: "number", description: "Max results (default 5, max 50)" },
        filter_tag: { type: "string", description: "Only return memories with this tag" },
      },
      required: ["query"],
    },
    handler: async (args: { query: string; project?: string; limit?: number; filter_tag?: string }) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required and must be non-empty");
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 50);
      const fanout = limit * 4;
      const project = args.project?.trim() || undefined;

      const qvec = await embed(query);
      const vecHits = vectorSearch(qvec, fanout, project);
      const ftsHits = ftsSearch(query, fanout, project);

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

      const finalResults = results.slice(0, limit);
      touchMemories(finalResults.map((r) => r.id));
      return {
        ok: true,
        method: "hybrid vector sqlite-vec + FTS5 keyword, ranked with reciprocal rank fusion",
        count: finalResults.length,
        results: finalResults,
      };
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
        project: { type: "string", description: "Filter to this project/repo only" },
      },
    },
    handler: async (args: { limit?: number; project?: string }) => {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
      const project = args.project?.trim() || undefined;
      const rows = listRecentMemories(limit, project);
      return {
        ok: true,
        total: countMemories(project),
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

  {
    name: "memory_health",
    description:
      "Audit local memory quality: duplicates, project casing variants, noisy long memories, secret-like content, stale entries, tag counts, and compaction recommendations.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional project/repo scope" },
      },
    },
    handler: async (args: { project?: string }) => {
      const project = args.project?.trim() || undefined;
      return { ok: true, project: project ?? null, health: getMemoryHealth(project) };
    },
  },

  {
    name: "compact_project",
    description:
      "Create a concise project summary from many active memories. Dry-run by default. When dry_run=false, stores a summary memory; when replace_originals=true, marks originals as superseded instead of deleting them.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project/repo name to compact" },
        max_memories: { type: "number", description: "How many recent active memories to summarize (default 20, max 100)" },
        dry_run: { type: "boolean", description: "Preview only; default true" },
        replace_originals: {
          type: "boolean",
          description: "Mark summarized originals as superseded after storing the summary; default false",
        },
      },
      required: ["project"],
    },
    handler: async (args: {
      project: string;
      max_memories?: number;
      dry_run?: boolean;
      replace_originals?: boolean;
    }) => {
      const project = String(args.project ?? "").trim();
      if (!project) throw new Error("project is required");
      const max = Math.min(Math.max(args.max_memories ?? 20, 2), 100);
      const candidates = listCompactionCandidates(project, max);
      if (candidates.length < 2) {
        return {
          ok: true,
          project,
          compacted: false,
          reason: "need at least two active non-summary memories",
          candidates: candidates.map(fmt),
        };
      }

      const summary = buildCompactionSummary(project, candidates);
      const dryRun = args.dry_run !== false;
      if (dryRun) {
        return {
          ok: true,
          project,
          compacted: false,
          dry_run: true,
          candidate_ids: candidates.map((memory) => memory.id),
          summary,
        };
      }

      const vec = await embed(summary);
      const memory = insertMemory({
        content: summary,
        source: "compact_project",
        project,
        tags: ["summary", "compacted", "maintenance"],
        embedding: vec,
        kind: "summary",
        quality_score: qualityScore(summary, project),
      });
      if (args.replace_originals) {
        markSuperseded(candidates.map((candidate) => candidate.id), memory.id);
      }
      return {
        ok: true,
        project,
        compacted: true,
        summary_memory: fmt(memory),
        superseded_ids: args.replace_originals ? candidates.map((candidate) => candidate.id) : [],
      };
    },
  },
];

export const TOOL_INDEX: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
