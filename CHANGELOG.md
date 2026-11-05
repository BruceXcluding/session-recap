# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.4.1] - 2026-11-05

### Changed
- The progress of a recap being written is animated: a spinner, a light sweeping the
  bar's unfilled part (so a long step visibly runs), and the time so far. The animation
  runs only while a recap is being written.

## [0.4.0] - 2026-11-05

### Added
- **Model selection.** In the pane, a **Model** button picks the recap model (the
  session's own, `haiku`, `sonnet`, `opus`) and a separate model for long sessions'
  parts; the choice is kept across sessions and each recap names its model. A
  **Recap model** plugin setting takes any model id. On the command line,
  `session-recap models` lists the provider's models, and `config set` / `config unset`
  save `model`, `partModel`, `api`, `baseUrl` and `apiKey` (from stdin, file mode 600).
- `session-recap list --all`.

### Changed
- **Each IDE shows its own sessions first.** The pane opens on Claude Code's sessions
  and `list` on the calling agent's; **All agents** / `--all` shows every agent's.
  The choice is remembered.
- **Projects screen:** the project this session runs in is pinned on top; the rest are
  grouped into Today / This week / Earlier; app-made scratch and temp folders are folded;
  paths are shortened (`~`, middle cut); agents are colour-coded.

### Fixed
- The command still registers if the host cannot report the session's folder or model.

## [0.3.1] - 2026-11-05

### Fixed
- dsh: a migrated session is read from its newer file, not the larger pre-migration one.
- An update re-reads the last prompt the previous recap covered, so a reply that
  arrived after a mid-turn recap is no longer lost.
- The Claude Code plugin's store is pruned (newest 250 recaps, 100 part notes)
  and old 0.2 keys are removed, so it never reaches its 4 MiB limit; part notes
  are written without a shared index, so parallel parts cannot overwrite each other.
- Installed skills give the CLI's full path as a fallback for agents whose tools
  run without the shell's PATH.
- `CODEX_HOME` / `DSH_HOME` in a shell profile no longer make the CLI think it runs
  inside Codex or dsh.
- `SESSION_RECAP_API` without a key or base URL no longer mixes with another
  provider's endpoint and key.
- OpenCode database paths with `#`, `?` or `%` open correctly.

### Changed
- `/session-recap` and name lookups scan sessions once instead of three times;
  `session-recap list` scans once instead of once per project.
- Code quality: the CLI is fully typed (JSDoc, checked with `tsc --strict`); Python is
  linted and formatted with ruff, JavaScript with Prettier; CI runs all three.
- Added CONTRIBUTING.md, SECURITY.md and .editorconfig.

## [0.3.0] - 2026-11-05

### Added
- **More agents.** Sessions from Codex, dsh (deepseek-harness) and OpenCode are read
  beside Claude Code's, grouped by project folder, with an agent filter in the pane.
- **Command-line tool** `session-recap` (`npm install -g github:BruceXcluding/session-recap`):
  recap, `list`, `projects`, `--dry-run`, `config`, and `install`, which adds a
  session-recap skill to Codex, OpenCode and `~/.agents/skills`. It calls an
  Anthropic or OpenAI-compatible model you configure.
- **Incremental updates:** a session that continued is recapped from the prompts
  after its last recap, merged into that recap.
- **Part notes cache:** condensed parts are cached by content hash.
- Optional cheaper model for condensing parts (`partModel` plugin setting,
  `SESSION_RECAP_PART_MODEL`).

### Changed
- The condensed transcript keeps every prompt, the agent's last reply of each turn,
  commits, pushes and PRs, and the edited files; tool calls that only read and
  intermediate replies are left out. About 63% fewer input tokens on a 179 MB session.
- Session listing is indexed under `~/.cache/session-recap` and re-reads only
  changed files.

## [0.2.0] - 2026-11-05

### Added
- Recap page: an **Intent** card and a **Where to resume** card at the top, with
  tabs (All / Decisions / Changes / Open threads) for the rest.
- Progress bar while a recap is written, and an error card with **Try again**.
- Session list shows the first line of each recap's intent under its title,
  with coloured status marks (ready / session changed since / none).
- `/session-recap <name>` opens a project by folder name, or recaps a session
  by title.

### Changed
- Every model call uses the session's own model, so the plugin works with any
  provider the session already uses (Anthropic, Bedrock, Vertex, gateways).

### Fixed
- A recap no longer shows as out of date when only the file timestamp's
  precision differs.
- A project whose newest session started in another folder is listed under its
  own folder name.
- An old error no longer stays on screen after a recap succeeds.

## 0.1.0 - 2026-11-05

### Added
- First release: the Session recap pane, `/session-recap` and
  `/session-recap browse`.
- Transcript condensing (`hooks/digest.py`) for sessions of hundreds of MB.
- Long sessions are condensed in parts in parallel, then merged into one recap.
- Recaps are cached per session and rewritten only when the session changes.

[0.4.1]: https://github.com/BruceXcluding/session-recap/releases/tag/v0.4.1
[0.4.0]: https://github.com/BruceXcluding/session-recap/releases/tag/v0.4.0
[0.3.1]: https://github.com/BruceXcluding/session-recap/releases/tag/v0.3.1
[0.3.0]: https://github.com/BruceXcluding/session-recap/releases/tag/v0.3.0
[0.2.0]: https://github.com/BruceXcluding/session-recap/releases/tag/v0.2.0
