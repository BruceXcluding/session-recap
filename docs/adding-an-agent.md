# Adding an agent

session-recap reads each AI coding agent's saved sessions with a small reader in [`hooks/digest.py`](../hooks/digest.py). Adding an agent is one reader, one fixture test and a few labels. Everything else (listing, condensing, secret removal, recaps, the MCP server, the viewer, the plugins) works for it from then on.

## 1. Find where the agent keeps sessions

Look in the agent's data folder for one file (or database row) per session. Note:

- the format (JSON lines, a SQLite database, compressed files…);
- where the session id, the working folder and a title are;
- which records are the person's prompts, which are the agent's replies, and which are tool calls;
- what the agent injects into the person's messages (environment blocks, instructions), which must not count as prompts;
- which sessions are not the person's own (subagents, reviews, empty sessions): those are left out.

Allow an environment variable to move the folder, like `CODEX_HOME` or `DSH_HOME`.

## 2. Write the reader

Two functions, next to the existing ones:

```python
def myagent_sessions(index):
    """One row per session: {"agent", "id", "cwd", "title"}; index.get adds path, size, mtimeMs."""
    rows = []
    for path in session_files():
        row = index.get(path, Lazy(lambda path=path: myagent_row(path)))  # read only when the file changed
        if not row.get("skip"):
            rows.append(row)
    return rows


def myagent_digest(path, out):
    """Fills `out` (an Entries) from one session."""
    for rec in records(path):
        out.stamp(timestamp)                # ISO time of the record
        out.meta.setdefault("cwd", cwd)     # also "title", "branch" when known
        out.prompt(clean_prompt(text), ts)  # a prompt of the person's; starts a turn
        out.reply(text)                     # the agent's reply; the turn keeps the last one
        out.shell(command)                  # a shell command; commits, pushes and PRs are kept
        out.edit(file_path)                 # a file the agent wrote or edited
```

Rules:

- **Read cheaply when listing.** Listing runs over every session on every open: read the head of a file, not all of it, and let `Index` cache the row. A row the person never wrote in is `{"skip": True}`.
- **Use `clean_prompt`** on the person's text; add the agent's own injected tags to it if they are not caught.
- **Standard library only**, runnable on Python 3.9 (what macOS ships).

Then register the reader:

- add `myagent_sessions` to `all_sessions()` and `myagent_digest` to `READERS`;
- add the agent's name to `AGENTS` in `hooks/digest.py` and `cli/session-recap.mjs`, and its label to `AGENT_LABEL` in `hooks/register.tsx`, `LABEL` in the CLI, `AGENTS` in `cli/viewer.html`, and `LABEL` in `packages/dsh/src/recap.js`;
- add its colour to `AGENT_COLOR` in `hooks/register.tsx` and to the `:root` variables in `cli/viewer.html`.

## 3. Test it with a synthetic session

In [`tests/test_digest.py`](../tests/test_digest.py), add a test class that writes a small fake session in a temporary home (see `CodexTest` or `DshTest`) and checks:

- the listing (agent, id, cwd, title; skipped sessions left out);
- the digest text (prompts, the last reply of a turn, kept actions, edited files);
- that injected blocks do not count as prompts.

**Never commit a real transcript**, not even a trimmed one: it holds someone's private work and, often, secrets.

## 4. Skills and MCP

If the agent reads skill files, add a target to `install()` in the CLI. If it is an MCP client, add its config shape to `mcpConfig()` (`session-recap mcp-config <client>`).

## 5. Open the pull request

Run the checks in [CONTRIBUTING.md](../CONTRIBUTING.md), add a line to `CHANGELOG.md` under *Unreleased*, and mention which version of the agent you tested with.
