# dsh-session-recap

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai) plugin from [session-recap](https://github.com/BruceXcluding/session-recap): recap this dsh session, or any saved Claude Code, Codex or OpenCode session, without leaving dsh.

- **Tool `session_recap`:** ask "recap this session" or "what was my session about the login page?" and the agent calls it.
- **Command `/recap [--refresh] [title words]`:** the same, typed.
- **Side panel (dsh web):** a **Session recap** tab in the right sidebar. It shows this session's recap with Intent and
  Where to resume cards, a Recap / Map switch and Decisions / Changes / Open threads tabs, plus the sessions of any
  project from every agent, marked by whether their recap is current. Reading writes nothing into the chat; **Write
  recap** runs `/recap` in the session, so the recap also lands in the chat as if typed.

A recap has five parts: the intent, key decisions and why, what changed, open threads, and where to resume. It is written with the session's own model route (or the `provider` / `model` set in the plugin config), so no separate API key is needed. Secrets in transcripts are removed before anything reaches the model. Recaps are cached in `~/.cache/session-recap`, shared with the session-recap command line tool, MCP server and viewer.

## Install

```bash
dsh plugin --profile <profile> add https://github.com/BruceXcluding/session-recap/releases/download/v0.6.0/dsh-session-recap-0.6.0.tgz
```

In DSH Desktop, install it from **Settings → Plugins**.

**Requirements:** `python3` and the `zstd` command (or Python 3.14+) on the machine.

**Status:** preview. Verified in dsh web 0.2.2-rc.1: the tool, the command and the side panel. Reports from other dsh
hosts (Desktop, CLI) are welcome.

The panel reads through `POST /api/session-recap/panel`, registered with dsh's `connection.fetch`, so dsh's own Host /
Origin checks and browser sign-in guard it and only the owner reaches it. On a host without that route, the panel asks
through `/recap --panel <json>` instead, and those answers show in the chat.
