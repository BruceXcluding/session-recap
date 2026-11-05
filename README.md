# session-recap

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center">
<img src="./.claude-plugin/icon.png" width="96" height="96" alt="session-recap icon">
</p>

<p align="center"><strong>Remember what every Claude Code session was for.</strong></p>

<p align="center"><sub>intent · key decisions · what changed · open threads · where to resume, for sessions of any length</sub></p>

<p align="center">
<a href="https://github.com/BruceXcluding/session-recap/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/BruceXcluding/session-recap/ci.yml?branch=main&style=flat-square&label=tests" alt="tests"></a>
<a href="https://github.com/BruceXcluding/session-recap/releases"><img src="https://img.shields.io/github/v/release/BruceXcluding/session-recap?style=flat-square" alt="release"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/BruceXcluding/session-recap?style=flat-square" alt="license"></a>
<a href="https://claude.com/product/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat-square" alt="Claude Code plugin"></a>
</p>

---

Projects grow, and so does the number of sessions in each one. After a few weeks a session is a 100 MB transcript you no longer remember: why you started it, what you decided, what was left half done. The sidebar shows a title and maybe a PR, not the reasoning.

**session-recap** reads a session's whole transcript and writes a short, structured recap in a pane beside the chat:

<p align="center">
<img src="./docs/recap-pane.svg" width="620" alt="The Session recap pane: an Intent card, a Where to resume card, and tabs for decisions, changes and open threads">
</p>

| Section | What it answers |
| --- | --- |
| **Intent** | What was I ultimately trying to achieve? |
| **Key ideas and decisions** | What did we choose, and why? Which alternatives were rejected? |
| **What changed** | Files, features, documents, commits, PRs |
| **Open threads** | What is unfinished, unverified or still a question |
| **Where to resume** | The most sensible next step today |

Recaps are written in the language you mostly write in that session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-recap --marketplace BruceXcluding/session-recap
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every session).

From a shell:

```bash
claude plugin install session-recap --marketplace BruceXcluding/session-recap
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins** → **Add marketplace** with `BruceXcluding/session-recap`, then **Add plugin**.

**Requirements:** Claude Code with plugin hooks support, and `python3` on the machine (macOS ships one at `/usr/bin/python3`).

## Usage

| Command | What it does |
| --- | --- |
| `/session-recap` | Recaps the session you are in |
| `/session-recap browse` | Lists every project, newest first, then its sessions |
| `/session-recap <project>` | Opens a project by folder name, e.g. `/session-recap web-shop` |
| `/session-recap <title words>` | Finds a session by its title and recaps it |

In the session list, each session shows the first line of its recap's intent, so you can tell sessions apart at a glance:

- <b>●</b> recap ready
- <b>◐</b> the session has continued since its recap (press **Refresh recap**)
- <b>○</b> no recap yet (open it and press **Write recap**)

Recaps are never written automatically: each one is started by you, because each one costs tokens.

## How it works

```
~/.claude/projects/<project>/<session>.jsonl        (can be hundreds of MB)
        │
        ▼
hooks/digest.py   keeps your prompts, Claude's replies, one line per tool call,
        │         edited files and commits; drops tool output and bookkeeping.
        │         179 MB → ~0.5 MB of text in ~0.3 s
        ▼
split into parts of ≤75k characters, cut at prompt boundaries
        │
        ├── part 1 ─┐
        ├── part 2 ─┼── condensed in parallel into notes  (the session's own model)
        └── part n ─┘
        │
        ▼
one merge call writes the five-section recap            (the session's own model)
        │
        ▼
cached in the plugin's store, keyed by session id + file size + mtime
```

- **Your provider, your model.** Every call goes through the session's own client and model, so it works with Anthropic, Bedrock, Vertex or a gateway, with no API key of its own.
- **Cached.** A recap is stored with the transcript's size and modification time and is reused until the session changes.
- **Local.** Transcripts are read on your machine. Text leaves it only as the model calls your session already makes.

## Develop

```bash
git clone https://github.com/BruceXcluding/session-recap
claude --plugin-dir ./session-recap        # load it from disk; edits reload live
```

| Check | Command |
| --- | --- |
| Plugin manifest and hooks | `claude plugin validate .` |
| Pane and pipeline tests (12) | `claude plugin test .` |
| Transcript condenser tests | `python3 -m unittest discover -s tests -p 'test_*.py'` |

Layout:

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   makes this repository installable
hooks/register.tsx                command, pane and recap pipeline
hooks/digest.py                   lists projects and sessions, condenses transcripts
types/index.d.ts                  state contract
tests/                            pane, end-to-end simulation and digest tests
```

## FAQ

**A recap fails with `api-error`.** The pane shows what the model call answered. A 4xx usually means the session's provider refused the call (credit, quota or model access); run any prompt in that session to check.

**Does it work for the session I'm in?** Yes. `/session-recap` recaps it as it stands; once the session goes on, the recap is marked ◐ and **Refresh recap** brings it up to date.

**How much does a recap cost?** Roughly the size of the condensed transcript in input tokens (a 179 MB session condenses to about 0.5 MB of text) plus a few thousand output tokens.

## License

[MIT](./LICENSE)
