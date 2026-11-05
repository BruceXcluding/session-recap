# Security and privacy

## What session-recap reads and sends

- It reads AI agents' saved sessions on your machine (`~/.claude/projects`, `~/.codex`, `~/.dsh`, OpenCode's database),
  read-only.
- It sends condensed transcript text to a model only when you ask for a recap: through your Claude Code session's own
  model (plugin), or the model you configure (CLI). Nothing is sent anywhere else, and there is no telemetry.
- Recaps are cached locally: in the plugin's store, and in `~/.cache/session-recap` for the CLI and the session index.
- The CLI reads API keys from environment variables or `~/.config/session-recap/config.json` and never prints them in full
  (`session-recap config` masks them).

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository
(**Security** tab → **Report a vulnerability**). You can expect a first reply within a week.
