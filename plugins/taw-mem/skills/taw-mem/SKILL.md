---
name: taw-mem
description: Use local-first persistent project memory through the taw-mem MCP server. Use when coding, debugging, reviewing, deploying, or continuing work where durable local context should be recalled or saved without a cloud memory service.
---

# taw-mem

Use taw-mem as local persistent memory for software work.

## Start Of Task

For non-trivial repo work, call `recall` on the `taw-mem` MCP server before changing files.

Choose `project` as the basename of the git root or current directory. Use one to three focused queries:

- Project overview: `<project> overview architecture setup conventions current status open todos`
- User intent: `<project> <action> <feature/component/domain> <important terms from prompt>`
- Component context: `<project> <component> prior decisions gotchas bugs tests deploy`

Memory is a hint, not source of truth. Verify against files, commands, tests, logs, or deployment state before making important changes.

## End Of Task

Before final response, either call `remember` for durable facts or state that memory was skipped.

Remember:

- root cause, fix, and verification
- architecture decisions or project conventions
- setup, test, deploy, host, port, or service details that are not obvious
- continuation checkpoints with next item, blockers, and dirty files
- user preferences that affect future engineering work

Never remember secrets, API keys, tokens, passwords, private keys, personal credentials, raw sensitive data, noisy command output, or raw transcripts.

## Maintenance

Use `memory_health` when recall looks stale, duplicate, noisy, or contradictory. Use `compact_project` after a dry run when a project accumulates many small memories.
