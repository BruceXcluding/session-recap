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
| Plugin | `claude plugin validate .` and `claude plugin test .` |

`npm run format` fixes formatting in both languages.

## Layout

| Path | What it is |
| --- | --- |
| `hooks/digest.py` | Reads each agent's saved sessions, indexes them, condenses one to text. Standard library only. |
| `core/recap.mjs` | Writes a recap from condensed text: parts, notes, merge, incremental update. Shared. |
| `hooks/register.tsx` | The Claude Code plugin: `/session-recap` and the pane. |
| `cli/session-recap.mjs` | The command-line tool and the skill installer. |
| `tests/` | Reader tests (Python), CLI tests (`node:test`), pane and pipeline tests (`claude plugin test`). |

## Adding an agent

1. In `hooks/digest.py`, add `<agent>_sessions(index)` (list rows: `agent`, `id`, `cwd`, `title`, read cheaply) and
   `<agent>_digest(path, out)` (fill an `Entries`: prompts, last replies, actions, edits).
2. Register them in `all_sessions()` and `READERS`, and add the label in `hooks/register.tsx` and the CLI.
3. Add a fixture test in `tests/test_digest.py` built from a small synthetic session, never a real one.
4. If the agent reads skills, add an `install` target in the CLI.

## Conventions

- Keep `digest.py` free of third-party packages, and runnable on the Python macOS ships (3.9).
- Never commit real transcripts or recaps: they hold private work. Test data is synthetic.
- Record user-facing changes in `CHANGELOG.md` under a new version.
