# session-recap

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center">
<img src="./.claude-plugin/icon.png" width="96" height="96" alt="session-recap icon">
</p>

<p align="center"><strong>Remember what every AI coding session was for.</strong></p>

<p align="center"><sub>intent · key decisions · what changed · open threads · where to resume, for sessions of any length, from any agent</sub></p>

<p align="center">
<a href="https://github.com/BruceXcluding/session-recap/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/BruceXcluding/session-recap/ci.yml?branch=main&style=flat-square&label=tests" alt="tests"></a>
<a href="https://github.com/BruceXcluding/session-recap/releases"><img src="https://img.shields.io/github/v/release/BruceXcluding/session-recap?style=flat-square" alt="release"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/BruceXcluding/session-recap?style=flat-square" alt="license"></a>
</p>

<p align="center">
<a href="https://claude.com/product/claude-code" title="Claude Code"><img src="https://cdn.simpleicons.org/claude/D97757" height="26" alt="Claude Code"></a>&nbsp;
<a href="https://github.com/openai/codex" title="Codex"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.iconify.design/simple-icons/openai.svg?color=white"><img src="https://api.iconify.design/simple-icons/openai.svg" height="26" alt="Codex"></picture></a>&nbsp;
<a href="https://www.deepseek.com" title="deepseek-harness (dsh)"><img src="https://cdn.simpleicons.org/deepseek/5786FE" height="26" alt="dsh"></a>&nbsp;
<a href="https://opencode.ai" title="OpenCode"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/opencode/FFFFFF"><img src="https://cdn.simpleicons.org/opencode/000000" height="26" alt="OpenCode"></picture></a>
</p>

---

Projects grow, and so does the number of sessions in each one, often across several agents. After a few weeks a session is a 100 MB transcript you no longer remember: why you started it, what you decided, what was left half done.

**session-recap** reads a session's whole transcript and writes a short, structured recap: in a pane beside the chat in Claude Code, or as Markdown from the command line in any agent.

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

## Supported agents

| Agent | Sessions read from | Recap in |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/` | pane + `/session-recap`, or the CLI |
| Codex | `~/.codex/sessions/`, `archived_sessions/` | the CLI, via the installed skill |
| dsh (deepseek-harness) | `~/.dsh/sessions/` (zstd) | the CLI, via `~/.agents/skills` |
| OpenCode | `~/.local/share/opencode/opencode.db` | the CLI, via the installed skill |

Each IDE shows its **own** sessions first: the Claude Code pane opens on Claude Code's, and `session-recap list` inside Codex lists Codex's. One switch (**All agents** in the pane, `--all` on the command line) shows every agent's sessions side by side, grouped by project folder, which is how you see that a project went from Claude Code to Codex last week. The choice is remembered. Codex review threads and dsh subagent sessions are always left out.

## Install

### Claude Code plugin

```
/plugin install session-recap --marketplace BruceXcluding/session-recap
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session). In the desktop app: **+** next to the prompt box → **Plugins** → **Add marketplace** `BruceXcluding/session-recap` → **Add plugin**.

The plugin uses your session's own model and needs no API key.

### Command line, for every agent

```bash
npm install -g github:BruceXcluding/session-recap
session-recap install        # adds the skill to Codex, OpenCode and ~/.agents/skills
```

Then ask the agent to "recap this session", or run `session-recap` in the project folder yourself.

Outside Claude Code there is no session model to borrow, so the CLI calls a model you configure:

```bash
export SESSION_RECAP_API=openai                  # or anthropic
export SESSION_RECAP_BASE_URL=https://api.deepseek.com
export SESSION_RECAP_API_KEY=sk-...
export SESSION_RECAP_MODEL=deepseek-chat
export SESSION_RECAP_PART_MODEL=deepseek-chat    # optional: a cheaper model for long sessions' parts
```

Without these it uses `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (with `ANTHROPIC_BASE_URL`), `DEEPSEEK_API_KEY` or `OPENAI_API_KEY`, whichever is set. The same settings can live in `~/.config/session-recap/config.json` (`api`, `baseUrl`, `apiKey`, `model`, `partModel`). `session-recap config` shows what is in use, with the key masked.

**Requirements:** `python3` (macOS ships one); Node.js 20+ for the CLI; the `zstd` command or Python 3.14+ for dsh sessions.

## Usage

### In Claude Code

| Command | What it does |
| --- | --- |
| `/session-recap` | Recaps the session you are in |
| `/session-recap browse` | Lists every project, then its sessions from every agent |
| `/session-recap <project>` | Opens a project by folder name |
| `/session-recap <title words>` | Finds a session by its title and recaps it |

The **Projects** screen pins the project this session runs in on top, groups the rest into Today / This week / Earlier, and folds app-made scratch and temp folders away. **Claude Code sessions / All agents** sets the scope.

**Recap and Map:** every recap has two views. **Recap** (the default) is the text: Intent and Where to resume on top, then Decisions, Changes and Open threads. **Map** draws the same recap as a journey: the phases the work went through, in order, with pivots marked (◆), down to "You are here"; then each key decision with the alternatives it turned down struck through and the reason; then counts of what shipped, what is open and what was rejected, each opening its list. The model writes the map's data with the recap, in the same call. Recaps written before 0.5 get theirs from **Build map**, one small call that reads only the recap. **Copy** copies the text.

**Choosing the model:** the **Model** button on the Projects and recap screens picks the model that writes recaps (the session's own, `haiku`, `sonnet` or `opus`) and, separately, a model for condensing long sessions' parts. Aliases resolve through the session's own provider settings, so `haiku` is whatever your setup maps it to. The choice is kept across sessions; each recap says which model wrote it. For a model id that is not an alias, set **Recap model** in the plugin's settings.

In the session list each session shows its agent and the first line of its recap's intent; **All / Claude Code / Codex / dsh / OpenCode** filter the list. ● recap ready · ◐ the session continued since (press **Update recap**) · ○ no recap yet.

### On the command line

| Command | What it does |
| --- | --- |
| `session-recap` | Recaps the newest session of the agent you run it in, in this folder |
| `session-recap "<title words>"` | Recaps the session whose title holds the words |
| `session-recap list [words]` | Lists sessions, newest first |
| `session-recap projects` | Lists project folders with sessions per agent |
| `session-recap --dry-run` | Shows how much would be sent to the model, and calls nothing |
| `session-recap --refresh` | Writes the recap again from the start |
| `session-recap models` | Lists the models your provider offers, marking the ones in use |
| `session-recap config set model <id>` | Saves the recap model (`partModel` for long sessions' parts, also `api`, `baseUrl`) |
| `echo "$KEY" \| session-recap config set apiKey -` | Saves the API key, read from stdin so it stays out of shell history (file mode 600) |
| `session-recap config` | Shows the settings in use, the key masked |

Add `--agent claude|codex|dsh|opencode` to pick an agent, `--all` for every agent, `--json` for JSON (with the recap's map as data under `map`). `--model` / `--part-model` override the saved models for one run.

## Token use

Listing sessions never calls a model. A recap sends only what it needs:

| Kept | Left out |
| --- | --- |
| every prompt of yours | tool output |
| the agent's **last** reply of each turn (its conclusion) | read-only tool calls, intermediate replies |
| commits, pushes, PRs, releases | reasoning, system and injected context blocks |
| the list of edited files | |

Measured on a real 179 MB Claude Code session (220 prompts): **528k → 195k characters, about 96k input tokens** for a first recap, about 63% less than v0.2.

- **Incremental updates:** when a session continues, only the prompts after the last recap are read, and merged into it. Ten new prompts on that session cost about 10k characters.
- **Part cache:** a long session is condensed in parts of ≤75k characters; each part's notes are cached by content hash, so a retried or repeated run condenses nothing twice.
- **Cheaper part model:** set `partModel` (plugin setting) or `SESSION_RECAP_PART_MODEL` to condense parts with a smaller model; the final recap stays on the main one.

## How it works

```
saved sessions (Claude Code · Codex · dsh · OpenCode)
        │
        ▼
hooks/digest.py   one reader per agent → turns: prompt, actions, last reply, edits
        │         listing is indexed in ~/.cache/session-recap (re-read only when a file changes)
        ▼
core/recap.mjs    parts of ≤75k chars, cut at prompts → notes (in parallel, cached)
        │         → one merge call: the five-section recap; or an update of the previous recap
        ▼
Claude Code pane (session model, plugin store)   ·   CLI (your model, ~/.cache/session-recap)
```

Transcripts are read on your machine. Text leaves it only in the model calls described above.

## Develop

```bash
git clone https://github.com/BruceXcluding/session-recap
claude --plugin-dir ./session-recap        # load the plugin from disk; edits reload live
node session-recap/cli/session-recap.mjs --help
```

| Check | Command |
| --- | --- |
| Plugin manifest and hooks | `claude plugin validate .` |
| Pane and pipeline tests | `claude plugin test .` |
| CLI tests | `node --test tests/cli.test.mjs` |
| Session reader tests | `python3 -m unittest discover -s tests -p 'test_*.py'` |

```
.claude-plugin/        plugin manifest, marketplace entry, icon
hooks/register.tsx     Claude Code command and pane
hooks/digest.py        session readers for every agent; condensing; index
core/recap.mjs         recap writing, shared by the plugin and the CLI
cli/session-recap.mjs  the command-line tool and skill installer
tests/                 pane, pipeline, CLI and reader tests
```

Adding an agent: a `<agent>_sessions` and `<agent>_digest` pair in `hooks/digest.py`, a fixture test in `tests/test_digest.py`, and an entry in the CLI's `install` targets.

## FAQ

**A recap fails with `api-error` or `HTTP 4xx`.** That is the model provider's answer: credit, quota, model access or a wrong base URL. `session-recap config` shows which endpoint and model the CLI uses.

**Does the CLI know which agent it runs in?** It reads the markers agents set (`CLAUDECODE`, `CODEX_*`, `OPENCODE`, `DSH_*`); the installed skills also pass `--agent` explicitly.

**Is dsh's skill support confirmed?** The skill goes to `~/.agents/skills`, the shared folder several agents read. If your dsh version does not pick it up, run `session-recap --agent dsh` from its shell tool.

## License

[MIT](./LICENSE)
