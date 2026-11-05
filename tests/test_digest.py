"""Tests for hooks/digest.py against synthetic transcripts.

Run: python3 -m unittest discover -s tests -p 'test_*.py'
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "hooks", "digest.py")
spec = importlib.util.spec_from_file_location("digest", SCRIPT)
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)


def user(text, ts="2026-11-01T10:00:00.000Z", cwd="/code/app", **extra):
    return {"type": "user", "cwd": cwd, "timestamp": ts, "gitBranch": "main",
            "message": {"role": "user", "content": text}, **extra}


def assistant(*blocks, ts="2026-11-01T10:01:00.000Z"):
    return {"type": "assistant", "cwd": "/code/app", "timestamp": ts,
            "message": {"role": "assistant", "content": list(blocks)}}


def text(t):
    return {"type": "text", "text": t}


def tool(name, **inp):
    return {"type": "tool_use", "id": "t", "name": name, "input": inp}


def write_jsonl(path, records):
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            # The engine writes bookkeeping records with "type" first and
            # messages with other fields first; mirror both.
            if r.get("type") in ("user", "assistant"):
                r = {"parentUuid": None, **r}
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def session(self, project, sid, records):
        folder = os.path.join(self.root, project)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, sid + ".jsonl")
        write_jsonl(path, records)
        return path

    def test_digest_keeps_prompts_replies_and_tools(self):
        path = self.session("-code-app", "s1", [
            {"type": "file-history-snapshot", "snapshot": {}},
            user("<system-reminder>ignore me</system-reminder>Build the checkout"),
            user("hidden", isMeta=True),
            user([{"type": "tool_result", "tool_use_id": "t", "content": "output"}]),
            assistant(text("Plan: one page."), tool("Edit", file_path="/code/app/a.ts"),
                      tool("WebSearch", query="stripe checkout")),
            {**user("sub agent"), "isSidechain": True},
            {"type": "custom-title", "customTitle": "Checkout"},
        ])
        d = digest.digest(path)
        self.assertEqual(d["title"], "Checkout")
        self.assertEqual(d["prompts"], 1)
        self.assertEqual(d["files"], ["/code/app/a.ts"])
        self.assertEqual(d["branch"], "main")
        self.assertIn("[USER 2026-11-01 10:00] Build the checkout", d["text"])
        self.assertIn("[CLAUDE] Plan: one page.", d["text"])
        self.assertIn("· WebSearch: stripe checkout", d["text"])
        for gone in ("ignore me", "hidden", "output", "sub agent"):
            self.assertNotIn(gone, d["text"])

    def test_commits_keep_a_longer_line(self):
        msg = "git commit -m '" + "x" * 300 + "'"
        path = self.session("-code-app", "s1", [assistant(tool("Bash", command=msg))])
        self.assertIn("x" * 300, digest.digest(path)["text"])

    def test_long_runs_of_tool_calls_are_folded(self):
        path = self.session("-code-app", "s1", [
            assistant(*[tool("Read", file_path="/f%d" % i) for i in range(10)])])
        out = digest.digest(path)["text"]
        self.assertIn("/f5", out)
        self.assertNotIn("/f6", out)
        self.assertIn("…more tool calls", out)

    def test_huge_sessions_fit_the_budget(self):
        records = []
        for i in range(400):
            records.append(user("ask %d " % i + "q" * 3000))
            records.append(assistant(text("answer %d " % i + "a" * 3000)))
        path = self.session("-code-app", "s1", records)
        out = digest.digest(path)["text"]
        self.assertLessEqual(len(out), digest.TEXT_BUDGET + 100)
        self.assertIn("ask 0 ", out)
        self.assertIn("ask 399 ", out)

    def test_sessions_list_titles_and_newest_first(self):
        old = self.session("-code-app", "old", [user("First idea")])
        os.utime(old, (1_000_000, 1_000_000))
        self.session("-code-app", "new", [
            user("Second"), {"type": "custom-title", "customTitle": "Named"}])
        rows = digest.list_sessions(os.path.join(self.root, "-code-app"))
        self.assertEqual([r["id"] for r in rows], ["new", "old"])
        self.assertEqual([r["title"] for r in rows], ["Named", "First idea"])

    def test_project_is_named_by_its_own_folder(self):
        # The newest session started in a scratch folder, then moved here.
        self.session("-code-app", "s1", [
            user("start", cwd="/tmp/scratch-1"),
            user("moved", cwd="/code/app", ts="2026-11-02T10:00:00.000Z"),
        ])
        rows = digest.list_projects(self.root)
        self.assertEqual(rows[0]["cwd"], "/code/app")
        self.assertEqual(rows[0]["sessions"], 1)

    def test_cli_prints_json(self):
        self.session("-code-app", "s1", [user("hello")])
        out = subprocess.run([sys.executable, "-I", SCRIPT, "projects", self.root],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out)[0]["cwd"], "/code/app")


if __name__ == "__main__":
    unittest.main()
