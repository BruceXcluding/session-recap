# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/BruceXcluding/session-recap/releases/tag/v0.2.0
