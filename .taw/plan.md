# Plan — taw-mem MCP server v1

## Goal
Build a working MCP memory server **right now**, plug into this Claude Code session, use it.

## Stack (chọn để zero-friction setup)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20+ TypeScript | Claude Code đã có Node, MCP SDK ổn nhất ở TS |
| MCP | `@modelcontextprotocol/sdk` | official, stdio transport |
| Storage | `better-sqlite3` (local file `~/.taw-mem/memory.db`) | zero infra, fast, single-file backup |
| Vector | `sqlite-vec` extension | embed vector search ngay trong SQLite, không cần Postgres/pgvector |
| Keyword | SQLite FTS5 (built-in) | hybrid search miễn phí |
| Embedding | `@xenova/transformers` `all-MiniLM-L6-v2` (local ONNX, 384-dim) | KHÔNG cần API key, chạy offline, đủ tốt cho v1 |

## MCP tools (v1)

```
remember(content, tags?, source?)  → id        # auto-embed + auto-tag
recall(query, limit=5, filter?)    → memory[]  # hybrid: vector + FTS5
get(id)                            → memory
list_recent(limit=20)              → memory[]
forget(id)                         → ok
```

Auto-tag heuristics (regex, light): `#code` if ```fenced, `#error` if "Error:" / stack trace, `#url` if http(s)://, `#todo` if /^TODO|FIX|HACK/i.

## File layout

```
taw-mem/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── server.ts         # MCP server entrypoint (stdio)
│   ├── db.ts             # SQLite + sqlite-vec + FTS5 schema
│   ├── embed.ts          # Xenova embedding wrapper (lazy load)
│   ├── tags.ts           # auto-tag regex
│   └── tools/
│       ├── remember.ts
│       ├── recall.ts
│       ├── get.ts
│       ├── list-recent.ts
│       └── forget.ts
└── dist/                 # tsc output, what Claude Code runs
```

## Steps

1. Scaffold `package.json`, `tsconfig.json`, deps install
2. DB schema (memories table + vec0 virtual + fts5 virtual)
3. Embedding wrapper (lazy-load Xenova, cache pipeline)
4. 5 MCP tools
5. `tsc` build → `dist/server.js`
6. `claude mcp add taw-mem -- node /Users/nguyennghia/Documents/GitHub/taw-mem/dist/server.js`
7. Smoke test: store 3 memories, recall with query, verify hybrid hit

## Out of scope (v2+)

- Tree-sitter AST chunking
- GitHub/git auto-import
- Auto session summary
- Cloud sync / multi-device
- Auth, billing, dashboard, landing
