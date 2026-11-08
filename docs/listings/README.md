# Where session-recap is listed

Drafts and steps for each place. Each submission goes out only after a release, and each is a public post, so it is done by hand by a maintainer.

| Where | What it lists | Needs | File |
| --- | --- | --- | --- |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (feeds the dsh-market plugin market) | the dsh plugin (listed since 2026-11-07; follows the latest release with no PR) | every release carries `dsh-session-recap.tgz`; the repository at least a day old; the `dsh-plugin` topic | [BruceXcluding__session-recap--packages-dsh.yml](BruceXcluding__session-recap--packages-dsh.yml) → `data/plugins/BruceXcluding__session-recap--packages-dsh.yml` |
| [Official MCP registry](https://github.com/modelcontextprotocol/registry) | the MCP server | the npm package published with `mcpName` (done for 0.6.0); `brew install mcp-publisher`, `mcp-publisher login github`, then `mcp-publisher publish` in the repository root; bump both `version` fields in `server.json` with each npm release | [`server.json`](../../server.json) (schema 2025-12-11) |
| Claude Code | the plugin | nothing more: `/plugin install session-recap --marketplace BruceXcluding/session-recap` works from the repository | [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) |
| Codex | the plugin | nothing more: the repository is a Codex plugin marketplace | [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) |
| npm | the CLI and MCP server | published: [`session-recap`](https://www.npmjs.com/package/session-recap); new versions with `npm publish` from the repository root | [`package.json`](../../package.json) |

## Release checklist

1. All checks green on `main` (CI).
2. `node scripts/build-dsh.mjs --pack` and attach both `dist/dsh-session-recap-<version>.tgz` and `dist/dsh-session-recap.tgz` to the GitHub release. The listing installs `releases/latest/download/dsh-session-recap.tgz`, so a release without the second file breaks installs from the market.
3. Tag `v<version>`, publish the GitHub release with the CHANGELOG section as notes.
4. `npm publish` (optional, needed for the MCP registry and `npx session-recap`).
5. Submit the listings above that are due.
