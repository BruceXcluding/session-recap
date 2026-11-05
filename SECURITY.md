# Security and privacy

## What session-recap reads and sends

- It reads AI agents' saved sessions on your machine (`~/.claude/projects`, `~/.codex`, `~/.dsh`, OpenCode's database),
  read-only.
- It sends condensed transcript text to a model only when you ask for a recap: through your Claude Code session's own
  model (plugin), the model you configure (CLI, viewer), or the agent that called the MCP server. Nothing is sent
  anywhere else, and there is no telemetry.
- Recaps are cached locally: in the plugin's store, and in `~/.cache/session-recap` for the CLI and the session index.
- The CLI reads API keys from environment variables or `~/.config/session-recap/config.json` and never prints them in full
  (`session-recap config` masks them).

## Secrets in transcripts

Transcripts often contain secrets: a key pasted into a prompt, a token printed by a command, a `.env` an agent read. Before any text reaches a model, `hooks/digest.py` replaces these with `[REDACTED:<kind>]`:

- private key blocks; Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe and npm tokens; JWTs; bearer tokens;
- credentials in URLs (`https://user:password@host`);
- assignments whose name says secret (`API_KEY=…`, `DB_PASSWORD: …`, `"token": "…"`), unless the value is a placeholder
  (`${VAR}`, `<…>`, `your-…`, `xxx`, `changeme`…).

The number removed is reported (`--dry-run`, and the MCP tool). This is pattern matching: it cannot know every format. If you find a secret it misses, report it privately (below) rather than in a public issue.

## The MCP server and the viewer

- `session-recap mcp` speaks only over stdin/stdout to the client that started it. Without a model of its own it hands
  the condensed, redacted transcript to that client's agent, which writes the recap.
- `session-recap serve` listens on `127.0.0.1` only, answers only requests carrying this run's random token (a cookie
  after the first page load) with a loopback `Host` header, and writes only on a request with a custom header, so other
  sites open in the browser cannot read or trigger anything through it.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository
(**Security** tab → **Report a vulnerability**). You can expect a first reply within a week.
