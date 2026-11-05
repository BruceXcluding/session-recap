# session-recap for Codex

A Codex plugin that runs the [session-recap](../../README.md) MCP server, so you can ask Codex to recap this session or an earlier one, from any agent.

1. Install the command line tool: `npm install -g session-recap`
2. Add this repository as a plugin marketplace in Codex and install **session-recap**. Or, without the plugin, add the MCP server directly: `session-recap mcp-config codex` prints the entry for `~/.codex/config.toml`.
3. Ask: "Recap this session", "What was my last session in this project about?", "总结一下这个会话".

Codex writes the recap with its own model; no API key is needed. Secrets in transcripts are removed before Codex sees them.
