# Where session-recap is listed

Drafts and steps for each place. Each submission goes out only after a release, and each is a public post, so it is done by hand by a maintainer.

| Where | What it lists | Needs | File |
| --- | --- | --- | --- |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (feeds the dsh-market plugin market) | the dsh plugin | a release with `dsh-session-recap-<version>.tgz`; the repository at least a day old; the `dsh-plugin` topic | [awesome-dsh-plugin.yml](awesome-dsh-plugin.yml) → `data/plugins/BruceXcluding__session-recap.yml` |
| [Official MCP registry](https://github.com/modelcontextprotocol/registry) | the MCP server | the npm package `session-recap` published, with `mcpName` in `package.json`; `mcp-publisher login github` then `mcp-publisher publish` | [`server.json`](../../server.json) |
| Claude Code | the plugin | nothing more: `/plugin install session-recap --marketplace BruceXcluding/session-recap` works from the repository | [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json) |
| Codex | the plugin | nothing more: the repository is a Codex plugin marketplace | [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) |
| npm | the CLI and MCP server | published: [`session-recap`](https://www.npmjs.com/package/session-recap); new versions with `npm publish` from the repository root | [`package.json`](../../package.json) |

## Release checklist

1. All checks green on `main` (CI).
2. `node scripts/build-dsh.mjs --pack` and attach `dist/dsh-session-recap-<version>.tgz` to the GitHub release.
3. Tag `v<version>`, publish the GitHub release with the CHANGELOG section as notes.
4. `npm publish` (optional, needed for the MCP registry and `npx session-recap`).
5. Submit the listings above that are due.
