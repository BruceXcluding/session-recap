"""Reads Claude Code transcripts for the session-recap mod.

  digest.py projects <projects-dir>      one row per project folder
  digest.py sessions <project-dir>       one row per session in it
  digest.py digest <session.jsonl>       the session condensed to text

Prints one JSON value. Transcripts run to hundreds of MB, so listing reads
only a file's head and tail, and digest skips every record that is not a
user or assistant message before parsing it.
"""

import json
import os
import sys

HEAD_LINES = 400
TAIL_BYTES = 2 * 1024 * 1024
TEXT_BUDGET = 600_000
SKIP_PREFIX = '{"type":"'


def head_records(path, limit=HEAD_LINES):
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i >= limit:
                return
            try:
                yield json.loads(line)
            except ValueError:
                continue


def tail_title(path):
    """The newest custom-title record, found in the file's tail."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - TAIL_BYTES))
        chunk = f.read().decode("utf-8", errors="replace")
    for line in reversed(chunk.splitlines()):
        if line.startswith('{"type":"custom-title"'):
            try:
                return json.loads(line).get("customTitle")
            except ValueError:
                continue
    return None


def prompt_text(rec):
    """A user record's typed prompt, or None for tool results and meta rows."""
    if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain"):
        return None
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        content = "\n".join(parts)
    if not isinstance(content, str):
        return None
    text = strip_tags(content).strip()
    if not text or text.startswith("<local-command") or text.startswith("Caveat:"):
        return None
    return text


def strip_tags(text):
    for tag in ("system-reminder", "local-command-stdout", "local-command-caveat"):
        while True:
            start = text.find("<" + tag)
            if start < 0:
                break
            end = text.find("</" + tag + ">", start)
            text = text[:start] + ("" if end < 0 else text[end + len(tag) + 3:])
    return text


def first_prompt(path):
    for rec in head_records(path):
        text = prompt_text(rec)
        if text:
            return text
    return None


def encode(cwd):
    """The projects folder name Claude Code gives a working directory."""
    return "".join(c if c.isalnum() else "-" for c in cwd)


def tail_cwds(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - TAIL_BYTES))
        chunk = f.read().decode("utf-8", errors="replace")
    for line in reversed(chunk.splitlines()):
        at = line.find('"cwd":"')
        if at >= 0:
            end = line.find('"', at + 7)
            if end > at:
                yield line[at + 7:end]


def project_cwd(folder, files):
    """The folder's own directory: a session may have started elsewhere and
    moved here, so the cwd that encodes to the folder's name wins."""
    name = os.path.basename(folder)
    seen = []
    for path in sorted(files, key=os.path.getmtime, reverse=True)[:5]:
        for rec in head_records(path, 60):
            if rec.get("cwd"):
                seen.append(rec["cwd"])
        seen.extend(tail_cwds(path))
    for cwd in seen:
        if encode(cwd) == name:
            return cwd
    return seen[0] if seen else name


def list_projects(root):
    rows = []
    for name in os.listdir(root):
        folder = os.path.join(root, name)
        if not os.path.isdir(folder):
            continue
        files = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".jsonl")]
        if not files:
            continue
        newest = max(files, key=os.path.getmtime)
        rows.append({
            "dir": folder,
            "cwd": project_cwd(folder, files),
            "sessions": len(files),
            "mtimeMs": int(os.path.getmtime(newest) * 1000),
        })
    rows.sort(key=lambda r: -r["mtimeMs"])
    return rows


def list_sessions(folder):
    rows = []
    for f in os.listdir(folder):
        if not f.endswith(".jsonl"):
            continue
        path = os.path.join(folder, f)
        st = os.stat(path)
        title = tail_title(path) or (first_prompt(path) or "(no prompt)")[:120]
        rows.append({
            "id": f[:-6],
            "path": path,
            "title": " ".join(title.split()),
            "size": st.st_size,
            "mtimeMs": int(st.st_mtime * 1000),
        })
    rows.sort(key=lambda r: -r["mtimeMs"])
    return rows


def clip(text, n):
    text = text.strip()
    return text if len(text) <= n else text[:n] + " …[cut]"


def tool_line(block):
    name = block.get("name", "?")
    inp = block.get("input") or {}
    arg = (inp.get("command") or inp.get("file_path") or inp.get("pattern")
           or inp.get("query") or inp.get("description") or inp.get("url") or inp.get("prompt") or "")
    if not isinstance(arg, str):
        arg = json.dumps(arg, ensure_ascii=False)
    arg = " ".join(arg.split())
    keep = 400 if ("git commit" in arg or "gh pr" in arg) else 140
    return "  · %s: %s" % (name, clip(arg, keep))


def read_entries(path):
    """(kind, text) per prompt, reply text and tool call, plus file and meta facts."""
    entries, files, meta = [], [], {"prompts": 0}
    seen_files = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith(SKIP_PREFIX):
                if line.startswith('{"type":"custom-title"'):
                    try:
                        meta["title"] = json.loads(line).get("customTitle")
                    except ValueError:
                        pass
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("isSidechain"):
                continue
            ts = rec.get("timestamp")
            if ts:
                meta.setdefault("firstTs", ts)
                meta["lastTs"] = ts
            if rec.get("cwd"):
                meta.setdefault("cwd", rec["cwd"])
            if rec.get("gitBranch"):
                meta["branch"] = rec["gitBranch"]
            if rec.get("type") == "user":
                text = prompt_text(rec)
                if text:
                    meta["prompts"] += 1
                    entries.append(("user", "[USER %s] %s" % ((ts or "")[:16].replace("T", " "), text)))
            elif rec.get("type") == "assistant":
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and block.get("text", "").strip():
                        entries.append(("assistant", "[CLAUDE] " + block["text"]))
                    elif block.get("type") == "tool_use":
                        entries.append(("tool", tool_line(block)))
                        inp = block.get("input") or {}
                        fp = inp.get("file_path")
                        if block.get("name") in ("Edit", "Write", "NotebookEdit") and isinstance(fp, str) and fp not in seen_files:
                            seen_files.add(fp)
                            files.append(fp)
    return entries, files, meta


def render(entries, user_cap, reply_cap, tools):
    out, run = [], 0
    for kind, text in entries:
        if kind == "tool":
            if not tools:
                continue
            run += 1
            if run <= 6:
                out.append(text)
            elif run == 7:
                out.append("  · …more tool calls")
            continue
        run = 0
        out.append(clip(text, user_cap if kind == "user" else reply_cap))
    return "\n".join(out)


def digest(path):
    entries, files, meta = read_entries(path)
    text = ""
    for user_cap, reply_cap, tools in ((4000, 1500, True), (2000, 600, True), (1200, 300, False), (800, 160, False)):
        text = render(entries, user_cap, reply_cap, tools)
        if len(text) <= TEXT_BUDGET:
            break
    if len(text) > TEXT_BUDGET:
        # Keep the opening (the intent) and the newest part (where it stands).
        head = TEXT_BUDGET // 5
        text = text[:head] + "\n\n[… middle of the session left out …]\n\n" + text[-(TEXT_BUDGET - head):]
    meta.update({"files": files[-80:], "fileCount": len(files), "text": text})
    return meta


def main():
    mode, arg = sys.argv[1], sys.argv[2]
    if mode == "projects":
        out = list_projects(arg)
    elif mode == "sessions":
        out = list_sessions(arg)
    elif mode == "digest":
        out = digest(arg)
    else:
        raise SystemExit("unknown mode " + mode)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
