# taw-mem

Local-first memory layer for AI coding agents. SQLite + sqlite-vec + FTS5 hybrid search, exposed as an MCP server. No cloud, no API keys, one `.db` file.

```
your AI agent  →  MCP stdio  →  taw-mem  →  ~/.taw-mem/memory.db
                                  │
                                  └─ vec0 (384-d, Xenova local) + FTS5
```

## Why

Existing memory tools (Mem0, Letta, Zep, Supermemory) are SaaS-first — your conversation history leaves your machine, you pay monthly, you depend on someone else's vector DB being up.

`taw-mem` is the opposite: one binary, one file, runs on localhost, all data stays on your laptop. You can `cp memory.db backup.db` and you're done. Embeddings happen locally via a 23 MB ONNX model — no OpenAI key, no Voyage key, no rate limits.

## What you get

**5 MCP tools** (callable by any MCP client — Claude Code, Cline, Continue, etc.):

| Tool | Purpose |
|---|---|
| `remember(content, tags?, source?)` | Store text. Auto-embeds + auto-tags (code/error/url/todo/cmd). |
| `recall(query, limit?, filter_tag?)` | Hybrid search (vector + FTS5) ranked via Reciprocal Rank Fusion (k=60). |
| `get(id)` | Fetch one memory by id. |
| `list_recent(limit?)` | Newest first. |
| `forget(id)` | Permanent delete. |

**Optional auto-recall hook** for Claude Code: every prompt you type gets a fast FTS keyword scan; if a relevant past memory exists, it's silently injected into the model's context. ~50 ms cold, silent on no-match. The model still calls `recall` when it wants semantic search — the hook is a safety net for "model forgot to query".

## Quickstart

```bash
git clone https://github.com/the-agents-work/taw-mem.git
cd taw-mem
npm install
npm run build
```

### Register as MCP server (Claude Code)

```bash
claude mcp add taw-mem --scope user -- node "$(pwd)/dist/server.js"
```

Restart Claude Code session. Tools appear as `mcp__taw_mem__remember`, `mcp__taw_mem__recall`, etc.

### Enable auto-recall hook (optional, Claude Code only)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/taw-mem/dist/hook-recall.js"
          }
        ]
      }
    ]
  }
}
```

Restart session. Now type a prompt that overlaps stored memories — model sees them as additional context.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `TAW_MEM_DB` | `~/.taw-mem/memory.db` | DB file location. Override for testing. |
| `TAW_MEM_HOOK_THRESHOLD` | `-1.0` | FTS5 bm25 rank floor for hook. More negative = stricter. `-2.0` for "only strong matches", `-0.5` for "everything looks relevant" (noisy). |

## Architecture

```
remember(content)
   ├─ autoTag (regex: code/error/url/todo/cmd)
   ├─ embed via Xenova all-MiniLM-L6-v2 (384-d, local ONNX)
   └─ insert into:
       ├─ memories                  (real table: id, content, tags, source, created_at)
       ├─ memories_vec  (vec0)      (384-d float vector)
       └─ memories_fts  (FTS5)      (unicode61, remove_diacritics=2)

recall(query)
   ├─ embed query
   ├─ vec_hits  = top-N from memories_vec  WHERE embedding MATCH ?
   ├─ fts_hits  = top-N from memories_fts MATCH "tok1" OR "tok2" ...
   └─ RRF fusion (k=60) → ranked list, optional tag filter
```

The FTS5 tokenizer uses `unicode61 remove_diacritics 2` so VN content with marks (`bí mật`) matches queries without (`bi mat`) and vice versa.

## Storage

All data in a single SQLite file:

```
~/.taw-mem/
├── memory.db           # backup = cp this
├── memory.db-wal       # WAL log (auto-checkpointed)
└── memory.db-shm       # shared memory
```

The `dist/hook-recall.js` script opens this DB read-only. Concurrent reads are safe; writes go through the MCP server.

## Roadmap

**v0.1** — current
- [x] MCP server, 5 tools, hybrid search, auto-tag
- [x] Local Xenova embeddings (384-d)
- [x] Claude Code auto-recall hook (FTS-only, 50 ms)

**v0.2** — defer until usage signals priority
- [ ] Daemon mode for hook → semantic search in <50 ms (today the hook skips embedding for speed)
- [ ] Per-project filter (tag by `cwd` automatically)
- [ ] Session summary auto-save (after N turns, save digest)

**v0.3+**
- [ ] Tree-sitter AST chunking for code memories
- [ ] GitHub commit auto-import
- [ ] OpenAI / Voyage embedding option (~30% better recall, costs API)
- [ ] Optional cloud sync (multi-device)

## Stack

| | |
|---|---|
| Runtime | Node 20+ |
| Language | TypeScript (NodeNext modules, strict) |
| MCP SDK | `@modelcontextprotocol/sdk` |
| DB | `better-sqlite3` + `sqlite-vec` (vec0 virtual table) |
| Embeddings | `@xenova/transformers` `Xenova/all-MiniLM-L6-v2` (quantized ONNX, ~23 MB) |
| Search | Reciprocal Rank Fusion over vec0 + FTS5 |

## Development

```bash
npm run dev       # tsc --watch
npm run build     # tsc once
node smoke-test.mjs   # end-to-end JSON-RPC stdio test against a temp DB
```

## License

MIT — see `LICENSE`.
