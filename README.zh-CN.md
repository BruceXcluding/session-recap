# session-recap

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">中文</a></p>

<p align="center">
<img src="./.claude-plugin/icon.png" width="96" height="96" alt="session-recap 图标">
</p>

<p align="center"><strong>记住每个 Claude Code 会话当初是为了什么。</strong></p>

<p align="center"><sub>核心意图 · 关键决策 · 改动 · 遗留问题 · 从哪里继续，再长的会话也适用</sub></p>

<p align="center">
<a href="https://github.com/BruceXcluding/session-recap/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/BruceXcluding/session-recap/ci.yml?branch=main&style=flat-square&label=tests" alt="tests"></a>
<a href="https://github.com/BruceXcluding/session-recap/releases"><img src="https://img.shields.io/github/v/release/BruceXcluding/session-recap?style=flat-square" alt="release"></a>
<a href="./LICENSE"><img src="https://img.shields.io/github/license/BruceXcluding/session-recap?style=flat-square" alt="license"></a>
<a href="https://claude.com/product/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat-square" alt="Claude Code plugin"></a>
</p>

---

项目越来越多，每个项目里的会话也越来越多。几周之后，一个会话就是一份上百 MB、你已经记不清的记录：当初为什么开始、做了哪些决定、哪些事做了一半。侧边栏只显示标题，最多再加一个 PR，看不到背后的思路。

**session-recap** 会读完一个会话的全部记录，在对话旁边的面板里写出一份简短、结构化的回顾：

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

## 安装

在 Claude Code 终端会话的输入框中：

```
/plugin install session-recap --marketplace BruceXcluding/session-recap
```

按 `y` 添加插件市场，然后选择安装范围（选用户范围则所有会话可用）。

在命令行中：

```bash
claude plugin install session-recap --marketplace BruceXcluding/session-recap
```

在 Claude 桌面应用中：点击输入框旁的 **+**，选择 **Plugins** → **Add marketplace**，填入 `BruceXcluding/session-recap`，再点 **Add plugin**。

**环境要求：**支持插件钩子的 Claude Code，以及本机的 `python3`（macOS 自带 `/usr/bin/python3`）。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/session-recap` | 回顾当前会话 |
| `/session-recap browse` | 列出所有项目（最新在前），再进入项目查看会话 |
| `/session-recap <项目名>` | 按文件夹名打开项目，例如 `/session-recap web-shop` |
| `/session-recap <标题关键词>` | 按标题找到会话并生成回顾 |

会话列表中，每个会话标题下会显示其回顾的意图首行，一眼就能分清各个会话：

- <b>●</b> 回顾已就绪
- <b>◐</b> 回顾之后会话又有进展（点 **Refresh recap** 更新）
- <b>○</b> 还没有回顾（打开后点 **Write recap**）

回顾不会自动生成，每次都由你手动开始，因为每次都要消耗 token。

## 工作原理

```
~/.claude/projects/<项目>/<会话>.jsonl            （可达数百 MB）
        │
        ▼
hooks/digest.py   保留你的提问、Claude 的回复、每次工具调用一行、
        │         编辑过的文件和提交；丢弃工具输出和内部记录。
        │         179 MB → 约 0.5 MB 文本，约 0.3 秒
        ▼
按提问边界切分，每段不超过 75k 字符
        │
        ├── 第 1 段 ─┐
        ├── 第 2 段 ─┼── 并行压缩成笔记             （使用会话自身的模型）
        └── 第 n 段 ─┘
        │
        ▼
一次合并调用写出五个部分的回顾                   （使用会话自身的模型）
        │
        ▼
存入插件存储，以会话 id + 文件大小 + 修改时间为键
```

- **用你自己的服务和模型。**所有调用都走会话自身的客户端和模型，Anthropic、Bedrock、Vertex 或网关都能用，插件不需要自己的 API key。
- **有缓存。**回顾连同记录文件的大小和修改时间一起保存，会话没变就一直复用。
- **本地读取。**记录在你的电脑上读取，文本只会随会话本来就会发出的模型调用离开本机。

## 开发

```bash
git clone https://github.com/BruceXcluding/session-recap
claude --plugin-dir ./session-recap        # 从磁盘加载，修改后自动重载
```

| 检查 | 命令 |
| --- | --- |
| 插件清单和钩子 | `claude plugin validate .` |
| 面板与流程测试（12 个） | `claude plugin test .` |
| 记录压缩器测试 | `python3 -m unittest discover -s tests -p 'test_*.py'` |

## 常见问题

**回顾失败，显示 `api-error`。**面板显示的是模型调用的返回。4xx 通常表示会话所用的服务拒绝了调用（余额、配额或模型权限），可在该会话中随便发一条消息确认。

**能回顾我正在用的会话吗？**可以。`/session-recap` 回顾它当前的样子；会话继续后，回顾会标为 ◐，点 **Refresh recap** 即可更新。

**一次回顾花多少？**输入 token 大约等于压缩后的记录大小（179 MB 的会话压缩后约 0.5 MB 文本），再加几千个输出 token。

## 许可证

[MIT](./LICENSE)
