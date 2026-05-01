const CODE_FENCE_RE = /```[\s\S]*?```/;
const ERROR_RE = /\b(?:Error|Exception|Traceback|stack trace)\b|\bat\s+\S+\s*\(.+:\d+:\d+\)/i;
const URL_RE = /\bhttps?:\/\/\S+/i;
const TODO_RE = /^\s*(?:TODO|FIXME|HACK|XXX)\b/im;
const CMD_RE = /^\s*\$\s+\S+/m;

export function autoTag(content: string): string[] {
  const tags = new Set<string>();
  if (CODE_FENCE_RE.test(content)) tags.add("code");
  if (ERROR_RE.test(content)) tags.add("error");
  if (URL_RE.test(content)) tags.add("url");
  if (TODO_RE.test(content)) tags.add("todo");
  if (CMD_RE.test(content)) tags.add("cmd");
  return [...tags];
}
