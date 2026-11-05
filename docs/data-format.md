# Data format

session-recap's output is versioned so others can build on it: viewers, exporters (Obsidian, Notion), dashboards.

## The recap

`session-recap --json` prints, and the MCP tool `recap_session` returns as `structuredContent` (when `mode` is `"recap"`), one object described by [`schema/recap-v1.schema.json`](../schema/recap-v1.schema.json):

```json
{
  "schemaVersion": 1,
  "format": "recap",
  "session": { "agent": "codex", "id": "…", "cwd": "/code/app", "title": "…", "size": 123456, "mtimeMs": 1793000000000 },
  "markdown": "## Intent\n…\n\n## Key ideas and decisions\n…",
  "map": {
    "phases": [{ "title": "Explore", "from": "2026-10-13", "to": "2026-10-20", "summary": "…", "pivot": false }],
    "decisions": [{ "chosen": "…", "rejected": ["…"], "why": "…", "status": "done" }],
    "shipped": ["…"],
    "open": ["…"],
    "rejected": ["…"]
  }
}
```

- `markdown` has the five sections, in the person's language: Intent, Key ideas and decisions, What changed, Open threads, Where to resume. [`core/sections.mjs`](../core/sections.mjs) finds them, also when a model translated the headings.
- `map` is `null` for recaps written before maps existed, and for formats other than `recap`.
- Fields may be added within version 1. Removing or changing one makes version 2.

## The cache

Recaps are stored in `~/.cache/session-recap/recaps/<agent>-<id>.json` (`$XDG_CACHE_HOME` moves it):

```json
{ "size": 123456, "mtimeMs": 1793000000000, "at": 1793000500000, "prompts": 42, "model": "…", "markdown": "…" }
```

`size` and `mtimeMs` are the transcript's when the recap was written: a recap whose numbers differ from the session's is out of date, and an update reads only the prompts after `prompts`. `markdown` holds the recap followed by its map as a fenced `json recap-map` block. The Claude Code plugin keeps its recaps in its own store; the CLI, MCP server and viewer read those too.
