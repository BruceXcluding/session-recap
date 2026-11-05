# session-recap

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center">
<img src="./.claude-plugin/icon.png" width="96" height="96" alt="session-recap 图标">
</p>

<p align="center"><strong>记住每个 AI 编程会话当初是为了什么。</strong></p>

<p align="center"><sub>核心意图 · 关键决策 · 改动 · 遗留问题 · 从哪里继续；再长的会话、哪个 agent 的会话都适用</sub></p>

<p align="center">
<a href="https://github.com/BruceXcluding/session-recap/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/BruceXcluding/session-recap/ci.yml?branch=main&style=flat-square&label=tests" alt="tests"></a>
<a href="https://github.com/BruceXcluding/session-recap/releases"><img src="https://img.shields.io/github/v/release/BruceXcluding/session-recap?style=flat-square" alt="release"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/BruceXcluding/session-recap?style=flat-square" alt="license"></a>
</p>

<p align="center">
<a href="https://claude.com/product/claude-code" title="Claude Code"><img src="https://cdn.simpleicons.org/claude/D97757" height="26" alt="Claude Code"></a>&nbsp;
<a href="https://github.com/openai/codex" title="Codex"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.iconify.design/simple-icons/openai.svg?color=white"><img src="https://api.iconify.design/simple-icons/openai.svg" height="26" alt="Codex"></picture></a>&nbsp;
<a href="https://www.deepseek.com" title="deepseek-harness (dsh)"><img src="https://cdn.simpleicons.org/deepseek/5786FE" height="26" alt="dsh"></a>&nbsp;
<a href="https://opencode.ai" title="OpenCode"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/opencode/FFFFFF"><img src="https://cdn.simpleicons.org/opencode/000000" height="26" alt="OpenCode"></picture></a>
</p>

---

项目越来越多，每个项目里的会话也越来越多，还常常分散在好几个 agent 里。几周之后，一个会话就是一份上百 MB、你已经记不清的记录：当初为什么开始、做了哪些决定、哪些事做了一半。

**session-recap** 会读完一个会话的全部记录，写出一份简短、结构化的回顾：在 Claude Code 里显示在对话旁的面板中，在任何 agent 里都可以用命令行输出 Markdown。

<p align="center">
<img src="./docs/recap-pane.svg" width="620" alt="Session recap 面板：意图卡片、从哪里继续卡片，以及决策、改动和遗留问题的标签页">
</p>

| 部分 | 回答的问题 |
| --- | --- |
| **Intent（意图）** | 我最终想达成什么？ |
| **Key ideas and decisions（关键思路与决策）** | 选了什么、为什么选，放弃了哪些方案？ |
| **What changed（改动）** | 文件、功能、文档、提交、PR |
| **Open threads（遗留问题）** | 还没做完、没验证或仍待回答的事 |
| **Where to resume（从哪里继续）** | 今天接着做，最合理的下一步 |

回顾使用你在该会话中主要使用的语言书写。

## 支持的 agent

| Agent | 会话读取位置 | 在哪里看回顾 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/` | 面板 + `/session-recap`，或命令行 |
| Codex | `~/.codex/sessions/`、`archived_sessions/` | 命令行，通过安装的 skill |
| dsh（deepseek-harness） | `~/.dsh/sessions/`（zstd 压缩） | 命令行，通过 `~/.agents/skills` |
| OpenCode | `~/.local/share/opencode/opencode.db` | 命令行，通过安装的 skill |

每个 IDE 先显示**自己的**会话：Claude Code 面板打开时只列 Claude Code 的会话，在 Codex 里运行 `session-recap list` 只列 Codex 的。一个开关（面板中的 **All agents**，命令行的 `--all`）可以把所有 agent 的会话按项目文件夹并排显示，这样就能看到一个项目上周从 Claude Code 转到了 Codex。选择会被记住。Codex 的自动评审线程和 dsh 的子 agent 会话始终不列出。

## 安装

### Claude Code 插件

```
/plugin install session-recap --marketplace BruceXcluding/session-recap
```

按 `y` 添加插件市场，再选择安装范围（用户范围 = 所有会话可用）。桌面应用中：输入框旁的 **+** → **Plugins** → **Add marketplace** 填 `BruceXcluding/session-recap` → **Add plugin**。

插件使用会话自身的模型，不需要 API key。

### 命令行，适用于所有 agent

```bash
npm install -g github:BruceXcluding/session-recap
session-recap install        # 为 Codex、OpenCode 和 ~/.agents/skills 添加 skill
```

之后对 agent 说"回顾一下这个会话"，或者自己在项目文件夹里运行 `session-recap`。

在 Claude Code 之外没有会话模型可借用，所以命令行会调用你配置的模型：

```bash
export SESSION_RECAP_API=openai                  # 或 anthropic
export SESSION_RECAP_BASE_URL=https://api.deepseek.com
export SESSION_RECAP_API_KEY=sk-...
export SESSION_RECAP_MODEL=deepseek-chat
export SESSION_RECAP_PART_MODEL=deepseek-chat    # 可选：长会话分段压缩用更便宜的模型
```

没有这些设置时，会依次使用已设置的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`（配合 `ANTHROPIC_BASE_URL`）、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`。同样的设置也可以写在 `~/.config/session-recap/config.json`（`api`、`baseUrl`、`apiKey`、`model`、`partModel`）。`session-recap config` 显示当前生效的设置，key 会打码。

**环境要求：**`python3`（macOS 自带）；命令行需要 Node.js 20+；读取 dsh 会话需要 `zstd` 命令或 Python 3.14+。

## 使用

### 在 Claude Code 中

| 命令 | 作用 |
| --- | --- |
| `/session-recap` | 回顾当前会话 |
| `/session-recap browse` | 列出所有项目，再看其中各 agent 的会话 |
| `/session-recap <项目名>` | 按文件夹名打开项目 |
| `/session-recap <标题关键词>` | 按标题找到会话并生成回顾 |

**Projects** 页面把当前会话所在的项目固定在最上方，其余按"今天 / 本周 / 更早"分组，应用临时创建的 scratch 和 tmp 文件夹会折叠起来。**Claude Code sessions / All agents** 切换显示范围。

**Recap 与 Map：**每份回顾有两种视图。**Recap**（默认）是文字：上方是意图和从哪里继续，下面是决策、改动和遗留问题。**Map** 把同一份回顾画成一段旅程：工作经历的各个阶段按时间排列，转向处用 ◆ 标出，一直到"You are here"；然后是每个关键决策，被放弃的方案划掉并附原因；最后是已交付、未完成和已放弃的数量，点开即可查看列表。Map 的数据由模型在写回顾时一并生成，同一次调用。0.5 之前写的回顾可以点 **Build map**，只读取回顾本身，一次小调用。**Copy** 复制的是文字。

**选择模型：**Projects 页和回顾页上的 **Model** 按钮可以选择写回顾的模型（会话自身的模型、`haiku`、`sonnet` 或 `opus`），并可单独选择压缩长会话分段的模型。别名按会话自身的服务设置解析，所以 `haiku` 就是你的配置把它映射到的模型。选择会跨会话保留，每份回顾都会标明由哪个模型写成。不是别名的模型 id，可在插件设置的 **Recap model** 中填写。

会话列表中每个会话都标出所属 agent 和回顾意图的首行；**All / Claude Code / Codex / dsh / OpenCode** 可筛选列表。● 回顾已就绪 · ◐ 回顾后会话又有进展（点 **Update recap**）· ○ 还没有回顾。

### 在命令行中

| 命令 | 作用 |
| --- | --- |
| `session-recap` | 回顾当前 agent 在此文件夹中最新的会话 |
| `session-recap "<标题关键词>"` | 回顾标题包含这些词的会话 |
| `session-recap list [关键词]` | 列出会话，最新在前 |
| `session-recap projects` | 列出项目文件夹及各 agent 的会话数 |
| `session-recap --dry-run` | 显示将发送给模型的内容大小，不调用模型 |
| `session-recap --refresh` | 从头重新生成回顾 |
| `session-recap models` | 列出服务提供的模型，并标出正在使用的 |
| `session-recap config set model <id>` | 保存写回顾的模型（`partModel` 为长会话分段模型，也可设 `api`、`baseUrl`） |
| `echo "$KEY" \| session-recap config set apiKey -` | 从 stdin 读取并保存 API key，不进 shell 历史（文件权限 600） |
| `session-recap config` | 显示当前生效的设置，key 打码 |

加 `--agent claude|codex|dsh|opencode` 指定 agent，加 `--all` 显示所有 agent，加 `--json` 输出 JSON（回顾的 map 数据在 `map` 字段中）。`--model` / `--part-model` 只对本次运行覆盖保存的模型。

## Token 用量

列出会话从不调用模型。生成回顾只发送需要的内容：

| 保留 | 舍弃 |
| --- | --- |
| 你的每一条提问 | 工具输出 |
| 每轮 agent 的**最后**一条回复（结论） | 只读的工具调用、中间回复 |
| 提交、推送、PR、发布 | 推理过程、系统和注入的上下文块 |
| 编辑过的文件列表 | |

在一个真实的 179 MB Claude Code 会话（220 条提问）上实测：首次回顾从 **528k 降到 195k 字符，约 96k 输入 token**，比 v0.2 少约 63%。

- **增量更新：**会话继续之后，只读取上次回顾之后的提问，并合并进原回顾。该会话新增 10 条提问时约 10k 字符。
- **分段缓存：**长会话按 ≤75k 字符分段压缩，每段笔记按内容哈希缓存，重试或重复运行时不会重复压缩。
- **更便宜的分段模型：**设置 `partModel`（插件设置）或 `SESSION_RECAP_PART_MODEL`，用小模型压缩分段，最终回顾仍用主模型。

## 工作原理

```
保存的会话（Claude Code · Codex · dsh · OpenCode）
        │
        ▼
hooks/digest.py   每个 agent 一个读取器 → 按轮整理：提问、操作、最后回复、编辑
        │         列表索引存在 ~/.cache/session-recap（文件变化才重新读取）
        ▼
core/recap.mjs    按提问边界切成 ≤75k 字符的分段 → 并行压缩成笔记（有缓存）
        │         → 一次合并调用写出五个部分的回顾，或更新上一份回顾
        ▼
Claude Code 面板（会话模型，插件存储）   ·   命令行（你配置的模型，~/.cache/session-recap）
```

记录在你的电脑上读取，文本只会随上述模型调用离开本机。

## 开发

```bash
git clone https://github.com/BruceXcluding/session-recap
claude --plugin-dir ./session-recap        # 从磁盘加载插件，修改后自动重载
node session-recap/cli/session-recap.mjs --help
```

| 检查 | 命令 |
| --- | --- |
| 插件清单和钩子 | `claude plugin validate .` |
| 面板与流程测试 | `claude plugin test .` |
| 命令行测试 | `node --test tests/cli.test.mjs` |
| 会话读取器测试 | `python3 -m unittest discover -s tests -p 'test_*.py'` |

添加新的 agent：在 `hooks/digest.py` 中加一对 `<agent>_sessions` 和 `<agent>_digest`，在 `tests/test_digest.py` 中加一个样例测试，并在命令行的 `install` 目标中加一项。

## 常见问题

**回顾失败，显示 `api-error` 或 `HTTP 4xx`。**这是模型服务的返回：余额、配额、模型权限或 base URL 不对。`session-recap config` 会显示命令行使用的地址和模型。

**命令行知道自己在哪个 agent 里运行吗？**它读取各 agent 设置的标记（`CLAUDECODE`、`CODEX_*`、`OPENCODE`、`DSH_*`）；安装的 skill 也会显式传入 `--agent`。

**dsh 对 skill 的支持确认了吗？**skill 安装在 `~/.agents/skills`，这是多个 agent 共同读取的文件夹。如果你的 dsh 版本没有识别它，可以在 dsh 的 shell 工具里运行 `session-recap --agent dsh`。

## 许可证

[MIT](./LICENSE)
