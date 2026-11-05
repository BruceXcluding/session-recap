"""Tests for hooks/digest.py against synthetic sessions of every agent.

Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "hooks", "digest.py")
spec = importlib.util.spec_from_file_location("digest", SCRIPT)
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)

HAS_ZSTD = shutil.which("zstd") is not None


def compact(record):
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def write_lines(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(compact(r) + "\n")


def claude_user(text, ts="2026-11-01T10:00:00.000Z", cwd="/code/app", **extra):
    # Messages put other fields first; bookkeeping records start with "type".
    return {"parentUuid": None, "type": "user", "cwd": cwd, "timestamp": ts, "gitBranch": "main",
            "message": {"role": "user", "content": text}, **extra}


def claude_assistant(*blocks, ts="2026-11-01T10:01:00.000Z"):
    return {"parentUuid": None, "type": "assistant", "cwd": "/code/app", "timestamp": ts,
            "message": {"role": "assistant", "content": list(blocks)}}


def text(t):
    return {"type": "text", "text": t}


def tool(name, **inp):
    return {"type": "tool_use", "id": "t", "name": name, "input": inp}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self.tmp.name)
        self.env = {}
        for k in ("HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
            self.env[k] = os.environ.pop(k, None)
        os.environ["HOME"] = self.home

    def tearDown(self):
        for k, v in self.env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        self.tmp.cleanup()

    def claude(self, sid, records, cwd="/code/app"):
        path = os.path.join(self.home, ".claude", "projects", digest.encode(cwd), sid + ".jsonl")
        write_lines(path, records)
        return path


class ClaudeTest(Base):
    def test_keeps_prompts_last_reply_actions_and_edits(self):
        path = self.claude("s1", [
            {"type": "file-history-snapshot", "snapshot": {}},
            claude_user("<system-reminder>ignore me</system-reminder>Build the checkout"),
            claude_user("hidden", isMeta=True),
            claude_user([{"type": "tool_result", "tool_use_id": "t", "content": "tool output"}]),
            claude_assistant(text("Looking around first."), tool("Read", file_path="/code/app/x.ts")),
            claude_assistant(tool("Edit", file_path="/code/app/a.ts"), tool("Bash", command="git commit -m 'one page'")),
            claude_assistant(text("Done: one page.")),
            {**claude_user("sub agent"), "isSidechain": True},
            {"type": "custom-title", "customTitle": "Checkout"},
        ])
        d = digest.digest("claude", path)
        self.assertEqual((d["title"], d["prompts"], d["files"], d["branch"]), ("Checkout", 1, ["/code/app/a.ts"], "main"))
        self.assertEqual(d["text"], "[USER 2026-11-01 10:00] Build the checkout\n"
                                    "  · git commit -m 'one page'\n"
                                    "[ASSISTANT] Done: one page.")

    def test_from_keeps_only_later_turns(self):
        path = self.claude("s1", [claude_user("ask %d" % i) for i in range(5)])
        d = digest.digest("claude", path, 3)
        self.assertEqual((d["prompts"], d["from"]), (5, 3))
        self.assertNotIn("ask 2", d["text"])
        self.assertIn("ask 3", d["text"])
        self.assertIn("ask 4", d["text"])

    def test_huge_sessions_fit_the_budget(self):
        records = []
        for i in range(800):
            records.append(claude_user("ask %d " % i + "q" * 3000))
            records.append(claude_assistant(text("answer %d " % i + "a" * 3000)))
        out = digest.digest("claude", self.claude("s1", records))["text"]
        self.assertLessEqual(len(out), digest.TEXT_BUDGET + 100)
        self.assertIn("ask 0 ", out)
        self.assertIn("ask 799 ", out)

    def test_injected_blocks_are_removed_from_prompts(self):
        path = self.claude("s1", [claude_user('look <in-app-browser-context source="x">page</in-app-browser-context> here')])
        self.assertIn("look  here", digest.digest("claude", path)["text"])

    def test_project_is_named_by_its_own_folder(self):
        self.claude("s1", [claude_user("start", cwd="/tmp/scratch-1"),
                           claude_user("moved", ts="2026-11-02T10:00:00.000Z")])
        rows = digest.list_projects()
        self.assertEqual(rows[0]["cwd"], "/code/app")
        self.assertEqual(rows[0]["agents"], {"claude": 1})

    def test_titles_and_order(self):
        old = self.claude("old", [claude_user("First idea")])
        os.utime(old, (1_000_000, 1_000_000))
        self.claude("new", [claude_user("Second"), {"type": "custom-title", "customTitle": "Named"}])
        self.claude("empty", [{"type": "file-history-snapshot"}])
        rows = digest.list_sessions("/code/app")
        self.assertEqual([(r["id"], r["title"]) for r in rows], [("new", "Named"), ("old", "First idea")])


class CodexTest(Base):
    def rollout(self, name, source, records):
        path = os.path.join(self.home, ".codex", "sessions", "2026", "11", "01", "rollout-%s.jsonl" % name)
        meta = {"timestamp": "2026-11-01T09:00:00.000Z", "type": "session_meta",
                "payload": {"id": name, "cwd": "/code/api", "thread_source": source, "git": {"branch": "dev"}}}
        write_lines(path, [meta] + records)
        return path

    def item(self, payload, ts="2026-11-01T09:05:00.000Z"):
        return {"timestamp": ts, "type": "response_item", "payload": payload}

    def test_reads_a_codex_rollout(self):
        path = self.rollout("t1", "user", [
            self.item({"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "rules"}]}),
            self.item({"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "<environment_context>\n<cwd>/code/api</cwd>\n</environment_context>"}]}),
            self.item({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Fix the login loop"}]}),
            self.item({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Checking cookies."}]}),
            self.item({"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "gh pr create --fill"})}),
            self.item({"type": "custom_tool_call", "name": "apply_patch",
                       "input": "*** Begin Patch\n*** Update File: src/login.ts\n@@\n*** Add File: src/new.ts\n"}),
            {"timestamp": "2026-11-01T09:09:00.000Z", "type": "event_msg",
             "payload": {"type": "task_complete", "last_agent_message": "Fixed; PR opened."}},
        ])
        self.rollout("r1", "guardian_review", [])
        with open(os.path.join(self.home, ".codex", "session_index.jsonl"), "w") as f:
            f.write(compact({"id": "t1", "thread_name": "Login loop"}) + "\n")
        rows = digest.list_sessions("/code/api")
        self.assertEqual([(r["agent"], r["id"], r["title"]) for r in rows], [("codex", "t1", "Login loop")])
        d = digest.digest("codex", path)
        self.assertEqual((d["prompts"], d["branch"], d["files"]), (1, "dev", ["src/login.ts", "src/new.ts"]))
        self.assertEqual(d["text"], "[USER 2026-11-01 09:05] Fix the login loop\n"
                                    "  · gh pr create --fill\n"
                                    "[ASSISTANT] Fixed; PR opened.")


@unittest.skipUnless(HAS_ZSTD, "needs the zstd command")
class DshTest(Base):
    def session(self, sid, records, header=None):
        folder = os.path.join(self.home, ".dsh", "sessions", "--code-web--", sid)
        raw = os.path.join(folder, "session.v3.jsonl")
        head = {"type": "session", "version": 3, "id": sid, "cwd": "/code/web", "delegationDepth": 0}
        head.update(header or {})
        write_lines(raw, [head] + records)
        subprocess.run(["zstd", "-q", "--rm", "-o", raw + ".zstd", raw], check=True)
        return raw + ".zstd"

    def test_reads_a_dsh_session(self):
        path = self.session("session-1", [
            {"type": "user/message", "time": 1793000000000,
             "data": {"content": [{"type": "text", "text": "Read the project"}], "source": {"kind": "user"}}},
            {"type": "session/title", "data": {"title": "Explore web"}},
            {"type": "assistant/message", "data": {"message": {"content": [
                {"type": "reasoning", "text": "thinking"}, {"type": "text", "text": "It is a shop."}]}}},
            {"type": "tool/call", "data": {"name": "bash", "arguments": json.dumps({"command": "git push origin main"})}},
            {"type": "tool/call", "data": {"name": "write_file", "arguments": json.dumps({"path": "notes.md"})}},
        ])
        self.session("session-2", [], {"origin": "subagent", "delegationDepth": 1})
        rows = digest.list_sessions("/code/web")
        self.assertEqual([(r["agent"], r["title"]) for r in rows], [("dsh", "Explore web")])
        d = digest.digest("dsh", path)
        self.assertEqual((d["title"], d["prompts"], d["files"]), ("Explore web", 1, ["notes.md"]))
        self.assertIn("[USER 2026-10-", d["text"])
        self.assertIn("  · git push origin main\n[ASSISTANT] It is a shop.", d["text"])
        self.assertNotIn("thinking", d["text"])


class OpenCodeTest(Base):
    def test_reads_opencode_sqlite(self):
        db_path = os.path.join(self.home, ".local", "share", "opencode", "opencode.db")
        os.makedirs(os.path.dirname(db_path))
        db = sqlite3.connect(db_path)
        db.executescript("""
            create table session (id text, project_id text, parent_id text, directory text, title text,
                                  time_updated integer);
            create table message (id text, session_id text, time_created integer, data text);
            create table part (id text, message_id text, session_id text, time_created integer, data text);
        """)
        db.execute("insert into session values ('ses1', 'p', null, '/code/cli', 'Add flags', 1793000000000)")
        db.execute("insert into session values ('ses2', 'p', 'ses1', '/code/cli', 'child', 1793000000000)")
        db.execute("insert into message values ('m1', 'ses1', 1, ?)", (compact({"role": "user"}),))
        db.execute("insert into message values ('m2', 'ses1', 2, ?)", (compact({"role": "assistant"}),))
        db.execute("insert into part values ('p1', 'm1', 'ses1', 1, ?)", (compact({"type": "text", "text": "Add a --json flag"}),))
        db.execute("insert into part values ('p2', 'm2', 'ses1', 2, ?)",
                   (compact({"type": "tool", "tool": "edit", "state": {"input": {"filePath": "cli.ts"}}}),))
        db.execute("insert into part values ('p3', 'm2', 'ses1', 3, ?)", (compact({"type": "text", "text": "Added."}),))
        db.commit()
        db.close()
        rows = digest.list_sessions("/code/cli")
        self.assertEqual([(r["agent"], r["id"], r["title"]) for r in rows], [("opencode", "ses1", "Add flags")])
        d = digest.digest("opencode", rows[0]["path"])
        self.assertEqual((d["prompts"], d["files"]), (1, ["cli.ts"]))
        self.assertTrue(d["text"].endswith("Add a --json flag\n[ASSISTANT] Added."))


class CommandTest(Base):
    def test_current_finds_the_nearest_folder_and_the_index_is_reused(self):
        self.claude("s1", [claude_user("hello")])
        sub = os.path.join(self.home, "x")
        os.makedirs(sub)
        self.assertIsNone(digest.current_session("claude", sub))
        self.assertEqual(digest.current_session("any", "/code/app/src/deep")["id"], "s1")
        self.assertTrue(os.path.exists(os.path.join(self.home, ".cache", "session-recap", "index-v2.json")))
        self.assertEqual(digest.current_session("codex", "/code/app"), None)

    def test_cli_prints_json(self):
        self.claude("s1", [claude_user("hello")])
        out = subprocess.run([sys.executable, "-I", SCRIPT, "find", "hello"], capture_output=True, text=True,
                             check=True, env={**os.environ}).stdout
        self.assertEqual(json.loads(out)[0]["cwd"], "/code/app")


if __name__ == "__main__":
    unittest.main()
