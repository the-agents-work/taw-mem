// Quick stdio JSON-RPC smoke test for the MCP server.
// Spawns dist/server.js, runs initialize → tools/list → remember → recall → forget.
// Uses a TEMP db so it doesn't pollute ~/.taw-mem.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "taw-mem-smoke-"));
const dbPath = join(tmp, "smoke.db");

const child = spawn("node", ["dist/server.js"], {
  env: { ...process.env, TAW_MEM_DB: dbPath },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error("[smoke] non-JSON line:", line);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function pretty(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(obj, null, 2).slice(0, 2000));
}

let exitCode = 0;
try {
  // 1) initialize
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  pretty("initialize", init.result);
  notify("notifications/initialized");

  // 2) tools/list
  const list = await send("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  pretty("tools/list", names);
  if (names.length !== 5) throw new Error(`expected 5 tools, got ${names.length}`);

  // 3) remember 3 sample memories
  const samples = [
    {
      content:
        "Got CORS error when calling https://api.example.com/users from localhost:3000. Fixed by adding Access-Control-Allow-Origin header on the backend.",
      source: "claude-code",
    },
    {
      content:
        "```ts\nfunction debounce<T extends (...args: any[]) => unknown>(fn: T, ms: number) {\n  let t: NodeJS.Timeout;\n  return (...args: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };\n}\n```",
      source: "snippet",
    },
    {
      content: "TODO: add rate limiting to /api/auth/login — saw bot attempts in logs",
      source: "todo",
    },
  ];

  const ids = [];
  for (const s of samples) {
    const r = await send("tools/call", { name: "remember", arguments: s });
    const text = r.result.content[0].text;
    if (r.result.isError) throw new Error("remember tool errored: " + text);
    const parsed = JSON.parse(text);
    if (!parsed.ok) throw new Error("remember failed: " + JSON.stringify(parsed));
    ids.push(parsed.memory.id);
    console.log(`  remembered #${parsed.memory.id} tags=${JSON.stringify(parsed.memory.tags)}`);
  }

  // 4) recall — semantic
  const recall1 = await send("tools/call", {
    name: "recall",
    arguments: { query: "browser cross origin policy", limit: 3 },
  });
  const r1 = JSON.parse(recall1.result.content[0].text);
  pretty("recall: 'browser cross origin policy'", r1.results.map((x) => ({ id: x.id, score: x._score, tags: x.tags, snippet: x.content.slice(0, 80) })));
  if (r1.results.length === 0) throw new Error("recall returned 0 results");
  if (!r1.results.some((x) => x.tags.includes("error"))) {
    console.warn("  ⚠️  expected the CORS memory to surface; got these instead");
  }

  // 5) recall — keyword
  const recall2 = await send("tools/call", {
    name: "recall",
    arguments: { query: "rate limiting login", limit: 3 },
  });
  const r2 = JSON.parse(recall2.result.content[0].text);
  pretty("recall: 'rate limiting login'", r2.results.map((x) => ({ id: x.id, score: x._score, tags: x.tags, snippet: x.content.slice(0, 80) })));

  // 6) recall with filter
  const recall3 = await send("tools/call", {
    name: "recall",
    arguments: { query: "function", filter_tag: "code", limit: 3 },
  });
  const r3 = JSON.parse(recall3.result.content[0].text);
  pretty("recall filter_tag=code", r3.results.map((x) => ({ id: x.id, tags: x.tags, snippet: x.content.slice(0, 80) })));

  // 7) list_recent
  const lr = await send("tools/call", { name: "list_recent", arguments: { limit: 10 } });
  const lrp = JSON.parse(lr.result.content[0].text);
  console.log(`\n=== list_recent ===\ntotal=${lrp.total} returned=${lrp.count}`);

  // 8) forget
  const fg = await send("tools/call", { name: "forget", arguments: { id: ids[0] } });
  const fgp = JSON.parse(fg.result.content[0].text);
  pretty("forget", fgp);

  console.log("\n✅ smoke test passed");
} catch (e) {
  console.error("\n❌ smoke test FAILED:", e?.message ?? e);
  exitCode = 1;
} finally {
  child.kill();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(exitCode);
}
