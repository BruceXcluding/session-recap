# Contributing to session-recap

Thanks for helping. Bug reports, new agents and fixes are all welcome.

## Set up

```bash
git clone https://github.com/BruceXcluding/session-recap
cd session-recap
npm install                     # dev tools only: Prettier, TypeScript, Node types
claude --plugin-dir .           # load the plugin from disk; edits reload live
node cli/session-recap.mjs --help
```

You need Node.js 20+, Python 3.9+, and for dsh sessions the `zstd` command (or Python 3.14+).
Python linting uses [ruff](https://docs.astral.sh/ruff/) (`pip install ruff==0.8.4`, or `uvx ruff@0.8.4`).

## Checks

Run these before opening a pull request; CI runs the same.

| What | Command |
| --- | --- |
| Formatting | `npx prettier --check .` and `ruff format --check hooks tests` |
| Lint | `ruff check hooks tests` |
| Types (CLI and core) | `npx tsc -p tsconfig.cli.json` |
| Session reader tests | `python3 -m unittest discover -s tests -p 'test_*.py'` |
| CLI tests | `node --test tests/cli.test.mjs` |
| MCP server and viewer | `node --test tests/mcp.test.mjs` |
| dsh plugin | `node scripts/build-dsh.mjs && node --test tests/dsh.test.mjs` |
| Plugin | `claude plugin validate .` and `claude plugin test .` |

`npm run format` fixes formatting in both languages.

## Layout

| Path | What it is |
| --- | --- |
| `hooks/digest.py` | Reads each agent's saved sessions, indexes them, condenses one to text. Standard library only. |
| `core/recap.mjs` | Writes a recap from condensed text: parts, notes, merge, incremental update. Shared. |
| `hooks/register.tsx` | The Claude Code plugin: `/session-recap` and the pane. |
| `core/formats.mjs` | Recap formats other than the default (standup, handoff, pr). Add one here. |
| `core/sections.mjs` | Finds a recap's five sections. Shared by the pane and the viewer. |
| `cli/session-recap.mjs` | The command-line tool, the skill installer and `mcp-config`. |
| `cli/mcp.mjs` | The MCP server (`session-recap mcp`). |
| `cli/serve.mjs`, `cli/viewer.html` | The local viewer (`session-recap serve`). |
| `packages/dsh/` | The dsh plugin; `scripts/build-dsh.mjs` vendors the reader and core into it. |
| `plugins/codex/` | The Codex plugin (runs the MCP server). |
| `schema/` | The JSON schema of `--json` and the MCP tool's output. See [docs/data-format.md](docs/data-format.md). |
| `tests/` | Reader tests (Python), CLI, MCP, viewer and dsh tests (`node:test`), pane tests (`claude plugin test`). |

## Adding an agent

See [docs/adding-an-agent.md](docs/adding-an-agent.md): one reader in `hooks/digest.py`, one fixture test, and the agent's label in a few places. Issues labelled **new-agent** list the agents people have asked for.

## Adding a recap format

Add an entry to `core/formats.mjs`: a name, a one-line description and the instructions. It is then available as `session-recap --format <name>` and as the MCP tool's `format`. Only the default format is cached and has a map.

## Conventions

- Keep `digest.py` free of third-party packages, and runnable on the Python macOS ships (3.9).
- Never commit real transcripts or recaps: they hold private work. Test data is synthetic, and test secrets are
  assembled at run time so the repository holds no string a scanner would take for a live key.
- Record user-facing changes in `CHANGELOG.md` under a new version.
