# dsh-session-recap

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai) plugin from [session-recap](https://github.com/BruceXcluding/session-recap): recap this dsh session, or any saved Claude Code, Codex or OpenCode session, without leaving dsh.

- **Tool `session_recap`:** ask "recap this session" or "what was my session about the login page?" and the agent calls it.
- **Command `/recap [title words]`:** the same, typed.

A recap has five parts: the intent, key decisions and why, what changed, open threads, and where to resume. It is written with the session's own model route (or the `provider` / `model` set in the plugin config), so no separate API key is needed. Secrets in transcripts are removed before anything reaches the model. Recaps are cached in `~/.cache/session-recap`, shared with the session-recap command line tool, MCP server and viewer.

## Install

```bash
dsh plugin --profile <profile> add https://github.com/BruceXcluding/session-recap/releases/download/v0.6.0/dsh-session-recap-0.6.0.tgz
```

In DSH Desktop, install it from **Settings → Plugins**.

**Requirements:** `python3` and the `zstd` command (or Python 3.14+) on the machine.

**Status:** preview. The tool and command are tested against dsh's plugin interfaces with stand-ins; reports from real dsh hosts are welcome.
