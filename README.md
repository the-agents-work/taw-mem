# taw-mem

Local-first MCP memory server. Plug into Claude Code (or any MCP client), agent gets persistent memory.

## What it does

5 tools exposed via MCP stdio:

- `remember(content, tags?, source?)` — store a memory, auto-embed + auto-tag
- `recall(query, limit?, filter?)` — hybrid search (vector + FTS5 keyword)
- `get(id)` — fetch one memory by id
- `list_recent(limit?)` — newest first
- `forget(id)` — delete

## Stack

- Node 20+ TypeScript
- `@modelcontextprotocol/sdk` — official MCP SDK (stdio transport)
- `better-sqlite3` + `sqlite-vec` — local file `~/.taw-mem/memory.db`
- `@xenova/transformers` `all-MiniLM-L6-v2` — local 384-d embeddings, no API key

## Install

```bash
npm install
npm run build
claude mcp add taw-mem -- node "$(pwd)/dist/server.js"
```

Restart Claude Code session. Tools appear as `mcp__taw_mem__*`.

## Storage

Single SQLite file at `~/.taw-mem/memory.db`. Backup = copy file. Move = move file.

## License

MIT
