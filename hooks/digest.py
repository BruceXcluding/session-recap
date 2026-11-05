"""Reads AI coding agents' saved sessions for session-recap.

  digest.py projects                      one row per project folder, all agents
  digest.py sessions <cwd>                the sessions of one project folder
  digest.py find <query>                  sessions whose id or title holds the query
  digest.py all                           every session, newest first
  digest.py context <query>               projects, the session matching query, its project's sessions
  digest.py current <agent|any> <cwd>     the newest session of an agent in a folder
  digest.py digest <agent> <path> [from]  a session condensed to text, from prompt `from`

Prints one JSON value. Agents: claude (Claude Code), codex (Codex), dsh
(deepseek-harness), opencode (OpenCode). Each is read where it keeps its
sessions; CLAUDE_CONFIG_DIR, CODEX_HOME, DSH_HOME and XDG_DATA_HOME move
them. Transcripts run to hundreds of MB, so listing reads only a file's head
and tail and keeps what it learned in an index under the cache folder.

The condensed text keeps what a recap needs and little else: every prompt
of the person's, the assistant's last reply of each turn (its conclusion),
commits, PRs and pushes, and the files edited. Tool output, tool calls that
only read, and the assistant's intermediate replies are left out.
"""

import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.parse

AGENTS = ("claude", "codex", "dsh", "opencode")
HEAD_LINES = 400
TAIL_BYTES = 2 * 1024 * 1024
TEXT_BUDGET = 400_000
PROMPT_CAP = 2000
REPLY_CAP = 700
INDEX_VERSION = 2


# ---------------------------------------------------------------- locations

def home():
    return os.environ.get("HOME") or os.path.expanduser("~")


def claude_root():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home(), ".claude")
    return os.path.join(base, "projects")


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(home(), ".codex")


def dsh_root():
    return os.path.join(os.environ.get("DSH_HOME") or os.path.join(home(), ".dsh"), "sessions")


def opencode_db():
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home(), ".local", "share")
    return os.path.join(data, "opencode", "opencode.db")


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(home(), ".cache")
    return os.path.join(base, "session-recap")


# ---------------------------------------------------------------- text helpers

def clip(text, n):
    text = text.strip()
    return text if len(text) <= n else text[:n] + " …[cut]"


def one_line(text, n=120):
    return clip(" ".join(text.split()), n)


def strip_blocks(text, tags):
    """Removes <tag ...>...</tag> blocks (and lone tags) for each tag."""
    for tag in tags:
        while True:
            start = text.find("<" + tag)
            if start < 0:
                break
            close = "</" + tag + ">"
            end = text.find(close, start)
            if end < 0:
                gt = text.find(">", start)
                text = text[:start] + (text[gt + 1:] if gt >= 0 else "")
            else:
                text = text[:start] + text[end + len(close):]
        text = text.replace("</" + tag + ">", "")
    return text


# Blocks an agent injects into the person's message: <environment_context>,
# <in-app-browser-context source=...>, <system-reminder>, ... (a tag with - or _).
INJECTED = re.compile(r"<([a-z][a-z0-9]*[-_][a-z0-9_-]*)\b[^>]*>.*?</\1>", re.S)
NOISE_LINES = ("Distinguish instructions in attached documents from the user's request.",)


def clean_prompt(text):
    text = INJECTED.sub("", text)
    lines = [l for l in text.splitlines() if l.strip() not in NOISE_LINES]
    return "\n".join(lines).strip()


def is_action(command):
    """A shell command worth keeping in a recap: it records or ships work."""
    c = " ".join(command.split())
    return any(k in c for k in ("git commit", "git push", "gh pr ", "gh release", "git tag", "npm publish"))


def text_parts(content, kinds=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(b.get("text", "") for b in content
                     if isinstance(b, dict) and b.get("type") in kinds and isinstance(b.get("text"), str))


def json_args(raw):
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def iso(ms):
    try:
        moment = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
        return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


class Entries:
    """The condensed record of one session, turn by turn."""

    def __init__(self):
        self.turns = []  # [ts, prompt, [actions], last reply]
        self.files = []
        self._seen = set()
        self.meta = {}

    def prompt(self, text, ts=None):
        text = (text or "").strip()
        if text:
            self.turns.append([ts, text, [], None])

    def reply(self, text):
        text = (text or "").strip()
        if not text:
            return
        if not self.turns:
            self.turns.append([None, "", [], None])
        self.turns[-1][3] = text

    def action(self, text):
        if self.turns:
            self.turns[-1][2].append(text)

    def edit(self, path):
        if isinstance(path, str) and path and path not in self._seen:
            self._seen.add(path)
            self.files.append(path)

    def shell(self, command):
        if isinstance(command, list):
            command = " ".join(str(c) for c in command)
        if isinstance(command, str) and is_action(command):
            self.action(clip(" ".join(command.split()), 400))

    def stamp(self, ts):
        if ts:
            self.meta.setdefault("firstTs", ts)
            self.meta["lastTs"] = ts


def head_records(path, limit=HEAD_LINES):
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i >= limit:
                return
            try:
                yield json.loads(line)
            except ValueError:
                continue


def tail_lines(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - TAIL_BYTES))
        chunk = f.read().decode("utf-8", errors="replace")
    return reversed(chunk.splitlines())


# ---------------------------------------------------------------- claude

CLAUDE_TAGS = ("system-reminder", "local-command-stdout", "local-command-caveat")


def claude_prompt(rec):
    if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain"):
        return None
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, list):
        content = text_parts(content, ("text",))
    if not isinstance(content, str):
        return None
    text = clean_prompt(strip_blocks(content, CLAUDE_TAGS))
    if not text or text.startswith("<local-command") or text.startswith("Caveat:"):
        return None
    return text


def encode(cwd):
    """The projects folder name Claude Code gives a working directory."""
    return "".join(c if c.isalnum() else "-" for c in cwd)


def claude_project_cwd(folder, files):
    """A session may start elsewhere and move here: the cwd that encodes to
    the folder's own name wins."""
    name = os.path.basename(folder)
    seen = []
    for path in sorted(files, key=os.path.getmtime, reverse=True)[:5]:
        for rec in head_records(path, 60):
            if rec.get("cwd"):
                seen.append(rec["cwd"])
        for line in tail_lines(path):
            at = line.find('"cwd":"')
            if at >= 0:
                end = line.find('"', at + 7)
                if end > at:
                    seen.append(line[at + 7:end])
    for cwd in seen:
        if encode(cwd) == name:
            return cwd
    return seen[0] if seen else name


def claude_row(path, cwd):
    title = None
    for line in tail_lines(path):
        if line.startswith('{"type":"custom-title"'):
            try:
                title = json.loads(line).get("customTitle")
                break
            except ValueError:
                continue
    if not title:
        for rec in head_records(path):
            title = claude_prompt(rec)
            if title:
                break
    return {"agent": "claude", "id": os.path.basename(path)[:-6], "cwd": cwd,
            "title": one_line(title or "(no prompt)")}


def claude_sessions(index):
    root = claude_root()
    if not os.path.isdir(root):
        return []
    rows = []
    for name in os.listdir(root):
        folder = os.path.join(root, name)
        if not os.path.isdir(folder):
            continue
        files = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".jsonl")]
        cwd = []

        def project_cwd():
            if not cwd:
                cwd.append(claude_project_cwd(folder, files))
            return cwd[0]

        for path in files:
            rows.append(index.get(path, lambda path=path: claude_row(path, project_cwd())))
    return rows


def claude_digest(path, out):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith('{"type":"'):
                if line.startswith('{"type":"custom-title"'):
                    try:
                        out.meta["title"] = json.loads(line).get("customTitle")
                    except ValueError:
                        pass
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("isSidechain"):
                continue
            out.stamp(rec.get("timestamp"))
            if rec.get("cwd"):
                out.meta.setdefault("cwd", rec["cwd"])
            if rec.get("gitBranch"):
                out.meta["branch"] = rec["gitBranch"]
            kind = rec.get("type")
            if kind == "user":
                text = claude_prompt(rec)
                if text:
                    out.prompt(text, rec.get("timestamp"))
            elif kind == "assistant":
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        out.reply(block.get("text"))
                    elif block.get("type") == "tool_use":
                        inp = block.get("input") or {}
                        if block.get("name") in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                            out.edit(inp.get("file_path") or inp.get("notebook_path"))
                        elif block.get("name") == "Bash":
                            out.shell(inp.get("command"))


# ---------------------------------------------------------------- codex

CODEX_TAGS = ("environment_context", "user_instructions", "user_shell_command", "turn_aborted",
              "image", "external_codex_apps_open_page", "permissions instructions", "INSTRUCTIONS")
CODEX_KINDS = ('"type":"response_item"', '"type":"event_msg"', '"type":"session_meta"')


def codex_prompt(content):
    text = clean_prompt(strip_blocks(text_parts(content, ("input_text", "text")), CODEX_TAGS))
    if not text or text.startswith("# AGENTS.md instructions") or text.startswith("<"):
        return None
    return text


def codex_titles():
    names = {}
    path = os.path.join(codex_home(), "session_index.jsonl")
    if os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("id") and rec.get("thread_name"):
                    names[rec["id"]] = rec["thread_name"]
    return names


def codex_row(path, titles):
    meta, title = None, None
    for i, rec in enumerate(head_records(path, 3000)):
        if i == 0:
            if rec.get("type") != "session_meta":
                return None
            meta = rec.get("payload") or {}
            # Review and agent-made threads are the agent's own, not the person's.
            if meta.get("thread_source") not in (None, "user"):
                return {"skip": True}
            title = titles.get(meta.get("id"))
            if title:
                break
            continue
        p = rec.get("payload") or {}
        if rec.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            title = codex_prompt(p.get("content"))
            if title:
                break
    if meta is None:
        return None
    return {"agent": "codex", "id": meta.get("id") or os.path.basename(path), "cwd": meta.get("cwd") or "?",
            "title": one_line(title or "(no prompt)")}


def codex_sessions(index):
    titles = []
    rows = []
    for sub in ("sessions", "archived_sessions"):
        for folder, _, files in os.walk(os.path.join(codex_home(), sub)):
            for f in files:
                if not (f.startswith("rollout-") and f.endswith(".jsonl")):
                    continue
                path = os.path.join(folder, f)

                def make(path=path):
                    if not titles:
                        titles.append(codex_titles())
                    return codex_row(path, titles[0]) or {"skip": True}

                row = index.get(path, make)
                if not row.get("skip"):
                    rows.append(row)
    return rows


def codex_digest(path, out):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            head = line[:200]
            if not any(k in head for k in CODEX_KINDS):
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            kind, p = rec.get("type"), rec.get("payload") or {}
            ts = rec.get("timestamp")
            if kind == "session_meta":
                out.meta.setdefault("cwd", p.get("cwd"))
                branch = (p.get("git") or {}).get("branch")
                if branch:
                    out.meta["branch"] = branch
                continue
            if kind == "event_msg":
                if p.get("type") == "task_complete":
                    out.reply(p.get("last_agent_message"))
                elif p.get("type") == "thread_name_updated" and p.get("thread_name"):
                    out.meta["title"] = p["thread_name"]
                continue
            out.stamp(ts)
            ptype = p.get("type")
            if ptype == "message" and p.get("role") == "user":
                text = codex_prompt(p.get("content"))
                if text:
                    out.prompt(text, ts)
            elif ptype == "message" and p.get("role") == "assistant":
                out.reply(text_parts(p.get("content"), ("output_text",)))
            elif ptype == "function_call":
                args = json_args(p.get("arguments"))
                out.shell(args.get("cmd") or args.get("command"))
            elif ptype == "local_shell_call":
                out.shell((p.get("action") or {}).get("command"))
            elif ptype == "custom_tool_call" and isinstance(p.get("input"), str):
                patch = p["input"]
                for marker in ("*** Update File: ", "*** Add File: ", "*** Delete File: "):
                    at = patch.find(marker)
                    while at >= 0:
                        end = patch.find("\n", at)
                        out.edit(patch[at + len(marker):end if end >= 0 else None].strip())
                        at = patch.find(marker, at + 1)


# ---------------------------------------------------------------- dsh

DSH_KINDS = ('{"type":"user/message"', '{"type":"assistant/message"', '{"type":"tool/call"',
             '{"type":"session"', '{"type":"session/title"')


def dsh_file(folder):
    """The session's transcript: the most recently written of its format versions.

    A migrated session keeps its old session.jsonl.zstd beside session.v3.jsonl.zstd;
    the old one can be larger but stops where the migration happened."""
    paths = [os.path.join(folder, n) for n in os.listdir(folder)
             if n.startswith("session") and n.endswith(".jsonl.zstd")]
    if not paths:
        return None
    return max(paths, key=lambda p: (os.path.getmtime(p), os.path.getsize(p)))


def zstd_lines(path, limit=None):
    try:
        import compression.zstd as zstd  # Python 3.14+
    except ImportError:
        zstd = None
    if zstd is not None:
        with zstd.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if limit is not None and i >= limit:
                    return
                yield line
        return
    proc = subprocess.Popen(["zstd", "-dc", "--", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for i, raw in enumerate(proc.stdout):
            if limit is not None and i >= limit:
                return
            yield raw.decode("utf-8", errors="replace")
    finally:
        proc.kill()
        proc.wait()


def dsh_row(path):
    header, title, first = None, None, None
    for i, line in enumerate(zstd_lines(path, 600)):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        kind = rec.get("type")
        if i == 0:
            if kind != "session":
                return None
            header = rec
            if rec.get("origin") == "subagent" or (rec.get("delegationDepth") or 0) > 0:
                return {"skip": True}
        elif kind == "session/title":
            title = (rec.get("data") or {}).get("title") or title
        elif kind == "user/message" and first is None:
            data = rec.get("data") or {}
            if (data.get("source") or {}).get("kind") == "user":
                first = text_parts(data.get("content"), ("text",))
    if header is None:
        return None
    return {"agent": "dsh", "id": header.get("id") or os.path.basename(os.path.dirname(path)),
            "cwd": header.get("cwd") or "?", "title": one_line(title or first or "(no prompt)")}


def dsh_sessions(index):
    root = dsh_root()
    rows = []
    if not os.path.isdir(root):
        return rows
    for project in os.listdir(root):
        pdir = os.path.join(root, project)
        if not os.path.isdir(pdir):
            continue
        for sid in os.listdir(pdir):
            folder = os.path.join(pdir, sid)
            path = dsh_file(folder) if os.path.isdir(folder) else None
            if path is None:
                continue
            row = index.get(path, lambda path=path: dsh_row(path) or {"skip": True})
            if not row.get("skip"):
                rows.append(row)
    return rows


def dsh_digest(path, out):
    for line in zstd_lines(path):
        if not line.startswith(DSH_KINDS):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        kind, data = rec.get("type"), rec.get("data") or {}
        ts = iso(rec["time"]) if rec.get("time") else None
        out.stamp(ts)
        if kind == "session":
            out.meta.setdefault("cwd", rec.get("cwd"))
        elif kind == "session/title" and data.get("title"):
            out.meta["title"] = data["title"]
        elif kind == "user/message" and (data.get("source") or {}).get("kind") == "user":
            out.prompt(clean_prompt(text_parts(data.get("content"), ("text",))), ts)
        elif kind == "assistant/message":
            out.reply(text_parts((data.get("message") or {}).get("content"), ("text",)))
        elif kind == "tool/call":
            args = json_args(data.get("arguments"))
            name = data.get("name") or ""
            if name in ("bash", "shell", "exec_command"):
                out.shell(args.get("command") or args.get("cmd"))
            elif any(k in name for k in ("write", "edit", "patch")):
                out.edit(args.get("path") or args.get("file_path") or args.get("filePath"))


# ---------------------------------------------------------------- opencode

def opencode_connect():
    path = opencode_db()
    if not os.path.exists(path):
        return None
    try:
        return sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path), uri=True)
    except sqlite3.Error:
        return None


def opencode_sessions():
    db = opencode_connect()
    if db is None:
        return []
    rows = []
    try:
        query = ("select s.id, s.directory, s.title, s.time_updated, "
                 "(select coalesce(sum(length(data)), 0) from part where session_id = s.id) "
                 "from session s where s.parent_id is null")
        for sid, directory, title, updated, size in db.execute(query):
            rows.append({"agent": "opencode", "id": sid, "cwd": directory, "title": one_line(title or sid),
                         "path": "%s#%s" % (opencode_db(), sid), "size": int(size or 0),
                         "mtimeMs": int(updated or 0)})
    except sqlite3.Error:
        return []
    finally:
        db.close()
    return rows


def opencode_digest(path, out):
    sid = path.rsplit("#", 1)[-1]
    db = opencode_connect()
    if db is None:
        return
    try:
        for title, directory in db.execute("select title, directory from session where id = ?", (sid,)):
            out.meta["title"], out.meta["cwd"] = title, directory
        messages = db.execute("select id, time_created, data from message where session_id = ? "
                              "order by time_created", (sid,)).fetchall()
        parts = {}
        for mid, data in db.execute("select message_id, data from part where session_id = ? "
                                    "order by time_created", (sid,)):
            parts.setdefault(mid, []).append(json_args(data))
        for mid, created, data in messages:
            role = json_args(data).get("role")
            ts = iso(created)
            out.stamp(ts)
            texts = []
            for part in parts.get(mid, []):
                if part.get("type") == "text" and not part.get("synthetic"):
                    texts.append(part.get("text") or "")
                elif part.get("type") == "tool":
                    inp = (part.get("state") or {}).get("input") or {}
                    tool = part.get("tool") or ""
                    if tool == "bash":
                        out.shell(inp.get("command"))
                    elif tool in ("edit", "write", "patch"):
                        out.edit(inp.get("filePath") or inp.get("path"))
            text = "\n".join(t for t in texts if t.strip())
            if role == "user":
                out.prompt(text, ts)
            elif role == "assistant":
                out.reply(text)
    finally:
        db.close()


# ---------------------------------------------------------------- index

class Index:
    """Rows learned from each file, reused while its size and mtime stand."""

    def __init__(self):
        self.path = os.path.join(cache_dir(), "index-v%d.json" % INDEX_VERSION)
        try:
            with open(self.path, encoding="utf-8") as f:
                self.rows = json.load(f)
        except (OSError, ValueError):
            self.rows = {}
        self.fresh = {}

    def get(self, path, make):
        st = os.stat(path)
        size, mtime = st.st_size, int(st.st_mtime * 1000)
        old = self.rows.get(path)
        if old and old.get("size") == size and old.get("mtimeMs") == mtime:
            row = old
        else:
            row = dict(make())
            row.update({"path": path, "size": size, "mtimeMs": mtime})
        self.fresh[path] = row
        return row

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.fresh, f, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            pass


def all_sessions():
    index = Index()
    rows = []
    for read in (claude_sessions, codex_sessions, dsh_sessions):
        try:
            rows.extend(read(index))
        except OSError:
            continue
    rows.extend(opencode_sessions())
    index.save()
    # A session the person never wrote in (opened, then left) has nothing to recap.
    rows = [r for r in rows if r.get("title") != "(no prompt)"]
    rows.sort(key=lambda r: -r["mtimeMs"])
    return rows


def list_projects():
    return group_projects(all_sessions())


def group_projects(rows):
    projects = {}
    for row in rows:
        p = projects.setdefault(row["cwd"], {"cwd": row["cwd"], "sessions": 0, "mtimeMs": 0, "agents": {}})
        p["sessions"] += 1
        p["mtimeMs"] = max(p["mtimeMs"], row["mtimeMs"])
        p["agents"][row["agent"]] = p["agents"].get(row["agent"], 0) + 1
    return sorted(projects.values(), key=lambda p: -p["mtimeMs"])


def list_sessions(cwd):
    return [r for r in all_sessions() if r["cwd"] == cwd]


def session_context(query):
    """One scan for a command: every project, the session matching `query`
    (its id exactly, else its title), and the sessions of its project."""
    rows = all_sessions()
    q = query.lower()
    hit = next((r for r in rows if r["id"].lower() == q), None) or \
        next((r for r in rows if q and q in r["title"].lower()), None)
    return {"projects": group_projects(rows), "session": hit,
            "sessions": [r for r in rows if hit is not None and r["cwd"] == hit["cwd"]]}


def find_sessions(query):
    q = query.lower()
    return [r for r in all_sessions() if q == r["id"].lower() or q in r["title"].lower()]


def current_session(agent, cwd):
    """The newest session of `agent` (or any) in `cwd`, else the nearest folder above."""
    rows = [r for r in all_sessions() if agent in ("any", r["agent"])]
    # Compare real paths too: /var and /private/var are one folder on macOS.
    real = {}
    for r in rows:
        if r["cwd"] not in real:
            real[r["cwd"]] = os.path.realpath(r["cwd"])
    here = os.path.realpath(cwd)
    while True:
        hits = [r for r in rows if here in (r["cwd"], real[r["cwd"]])]
        if hits:
            return hits[0]
        parent = os.path.dirname(here)
        if parent == here:
            return None
        here = parent


# ---------------------------------------------------------------- digest

READERS = {"claude": claude_digest, "codex": codex_digest, "dsh": dsh_digest, "opencode": opencode_digest}


def render(turns, prompt_cap, reply_cap):
    out = []
    for ts, prompt, actions, reply in turns:
        if prompt:
            stamp = (ts or "")[:16].replace("T", " ")
            out.append(("[USER %s] " % stamp if stamp else "[USER] ") + clip(prompt, prompt_cap))
        for a in actions[-8:]:
            out.append("  · " + a)
        if reply:
            out.append("[ASSISTANT] " + clip(reply, reply_cap))
    return "\n".join(out)


def digest(agent, path, start=0):
    out = Entries()
    READERS[agent](path, out)
    turns = [t for t in out.turns if t[1] or t[3]]
    prompts = sum(1 for t in turns if t[1])
    # `start` counts the prompts an earlier recap covered. Keep the turns after
    # them and the last covered one too: a recap written mid-turn has not seen
    # how that turn ended.
    seen, keep = 0, []
    for t in turns:
        if t[1]:
            seen += 1
        if start == 0 or seen >= start:
            keep.append(t)
    text = ""
    for prompt_cap, reply_cap in ((PROMPT_CAP, REPLY_CAP), (2000, 700), (1200, 350), (800, 200)):
        text = render(keep, prompt_cap, reply_cap)
        if len(text) <= TEXT_BUDGET:
            break
    if len(text) > TEXT_BUDGET:
        # Keep the opening (the intent) and the newest part (where it stands).
        head = TEXT_BUDGET // 5
        text = text[:head] + "\n\n[… middle of the session left out …]\n\n" + text[-(TEXT_BUDGET - head):]
    meta = out.meta
    meta.update({"agent": agent, "prompts": prompts, "from": min(start, prompts),
                 "files": out.files[-80:], "fileCount": len(out.files), "text": text})
    return meta


def main():
    mode, args = sys.argv[1], sys.argv[2:]
    if mode == "projects":
        out = list_projects()
    elif mode == "sessions":
        out = list_sessions(args[0])
    elif mode == "find":
        out = find_sessions(args[0])
    elif mode == "all":
        out = all_sessions()
    elif mode == "context":
        out = session_context(args[0])
    elif mode == "current":
        out = current_session(args[0], args[1])
    elif mode == "digest":
        out = digest(args[0], args[1], int(args[2]) if len(args) > 2 else 0)
    else:
        raise SystemExit("unknown mode " + mode)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
