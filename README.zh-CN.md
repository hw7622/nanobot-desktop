# nanobot：超轻量个人 AI 助手

<div align="center">
  <img src="nanobot_logo.png" alt="nanobot" width="420">
</div>

`nanobot` 是一个面向个人使用和二次开发的超轻量 AI 助手框架，灵感来自 [OpenClaw](https://github.com/openclaw/openclaw)。

它的目标不是堆很多抽象层，而是在尽量少的代码里，提供一套够用、清晰、可扩展的 Agent 运行时：

- 轻量，核心逻辑体量小，适合阅读和二次开发
- 支持多种 LLM Provider，包括 OpenRouter、OpenAI、Anthropic、DeepSeek、Gemini、Ollama、vLLM 等
- 支持多种聊天渠道，包括 Telegram、Discord、WhatsApp、飞书、钉钉、Slack、QQ、企业微信、Email 等
- 内置工具调用、文件系统访问、Shell 执行、Web 搜索、MCP、定时任务、心跳唤醒
- 既能本地 CLI 对话，也能以网关形式长期运行

> 项目当前版本：`0.1.4.post5`
>
> Python 要求：`>= 3.11`

## 架构图

<p align="center">
  <img src="nanobot_arch.png" alt="nanobot architecture" width="820">
</p>

## 目录

- [核心特点](#核心特点)
- [安装](#安装)
- [5 分钟快速开始](#5-分钟快速开始)
- [聊天渠道](#聊天渠道)
- [常用配置](#常用配置)
- [CLI 命令](#cli-命令)
- [Docker 部署](#docker-部署)
- [周期任务与心跳](#周期任务与心跳)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [相关文档](#相关文档)

## 核心特点

- 超轻量：核心代码量非常小，便于理解 Agent 主循环、上下文拼装、工具执行和会话管理
- 研究友好：适合作为个人助手、实验项目、原型验证或教学示例
- 多 Provider：可直连官方模型，也可接 OpenAI 兼容网关或本地模型
- 多渠道：支持将同一 Agent 接到 IM、邮件或 CLI
- 工具能力完整：文件、Shell、Web、MCP、子代理、定时任务、心跳机制都已具备
- 易扩展：Provider 和 Channel 都采用注册/发现机制，新增能力成本较低

## 安装

### 方式一：从源码安装

```bash
git clone https://github.com/HKUDS/nanobot.git
cd nanobot
pip install -e .
```

### 方式二：使用 `uv`

```bash
uv tool install nanobot-ai
```

### 方式三：从 PyPI 安装

```bash
pip install nanobot-ai
```

### 升级

```bash
pip install -U nanobot-ai
nanobot --version
```

或：

```bash
uv tool upgrade nanobot-ai
nanobot --version
```

## 5 分钟快速开始

### 1. 初始化配置

```bash
nanobot onboard
```

初始化后会自动创建：

- 配置文件
  Linux/macOS：`~/.nanobot/config.json`
  Windows：`%USERPROFILE%\.nanobot\config.json`
- 工作区目录
  Linux/macOS：`~/.nanobot/workspace`
  Windows：`%USERPROFILE%\.nanobot\workspace`

### 2. 配置模型提供方

最小可用配置通常只需要两部分：`providers` 和 `agents.defaults`。

示例：使用 `OpenRouter`

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-v1-xxx"
    }
  },
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-4-5",
      "provider": "openrouter"
    }
  }
}
```

如果你使用本地 `Ollama`：

```json
{
  "providers": {
    "ollama": {
      "apiBase": "http://localhost:11434"
    }
  },
  "agents": {
    "defaults": {
      "provider": "ollama",
      "model": "llama3.2"
    }
  }
}
```

如果你要连接任意 OpenAI 兼容接口：

```json
{
  "providers": {
    "custom": {
      "apiKey": "your-api-key",
      "apiBase": "https://your-endpoint.example.com/v1"
    }
  },
  "agents": {
    "defaults": {
      "model": "your-model-name"
    }
  }
}
```

> 对于本地 OpenAI 兼容服务，如果实际上不校验密钥，`apiKey` 也建议填任意非空字符串，例如 `"dummy"` 或 `"no-key"`。

### 3. 启动对话

```bash
nanobot agent
```

单次执行：

```bash
nanobot agent -m "你好，帮我概括一下当前工作区有哪些文件"
```

到这里，一个可用的个人 AI 助手就跑起来了。

## 聊天渠道

`nanobot` 可以作为长期运行的消息网关，把同一个 Agent 接到不同平台。

当前仓库内置的渠道包括：

- Telegram
- Discord
- WhatsApp
- 飞书
- Mochat
- 钉钉
- Slack
- Email
- QQ
- 企业微信
- Matrix

典型流程是：

1. 在 `config.json` 中启用对应渠道
2. 写入渠道凭证，例如 Token、App ID / Secret 或邮箱账号
3. 运行 `nanobot gateway`

Telegram 示例：

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "allowFrom": ["YOUR_USER_ID"]
    }
  }
}
```

启动网关：

```bash
nanobot gateway
```

查看渠道状态：

```bash
nanobot channels status
```

如果是 WhatsApp，需要先登录桥接服务：

```bash
nanobot channels login
```

> 自定义渠道插件的开发方式见 [docs/CHANNEL_PLUGIN_GUIDE.md](./docs/CHANNEL_PLUGIN_GUIDE.md)。

## 常用配置

配置文件默认位于 `~/.nanobot/config.json`，整体结构大致如下：

> 配置同时兼容 `snake_case` 和 `camelCase` 键名；本文示例优先沿用项目文档中更常见的 `camelCase` 写法。

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.nanobot/workspace",
      "model": "anthropic/claude-opus-4-5",
      "provider": "auto",
      "maxTokens": 8192,
      "contextWindowTokens": 65536,
      "temperature": 0.1,
      "maxToolIterations": 40,
      "reasoningEffort": null
    }
  },
  "providers": {},
  "channels": {
    "sendProgress": true,
    "sendToolHints": false
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": 18790
  },
  "tools": {
    "restrictToWorkspace": false,
    "web": {
      "proxy": null,
      "search": {
        "provider": "brave",
        "apiKey": "",
        "baseUrl": "",
        "maxResults": 5
      }
    },
    "exec": {
      "timeout": 60,
      "pathAppend": ""
    },
    "mcpServers": {}
  }
}
```

### Provider

代码中已内置的 Provider 包括：

- `custom`
- `azure_openai`
- `anthropic`
- `openai`
- `openrouter`
- `deepseek`
- `groq`
- `zhipu`
- `dashscope`
- `vllm`
- `ollama`
- `gemini`
- `moonshot`
- `minimax`
- `aihubmix`
- `siliconflow`
- `volcengine`
- `volcengine_coding_plan`
- `byteplus`
- `byteplus_coding_plan`
- `openai_codex`
- `github_copilot`

其中：

- `provider: "auto"` 会根据模型名、`apiBase`、`apiKey` 等信息自动匹配 Provider
- `openai_codex` 和 `github_copilot` 使用 OAuth 登录
- `ollama`、`vllm` 适合本地或私有部署

OAuth 登录示例：

```bash
nanobot provider login openai-codex
nanobot provider login github-copilot
```

### Web 搜索

启用 Web 搜索时，配置位于 `tools.web.search`。支持的搜索 Provider 包括：

- `brave`
- `tavily`
- `duckduckgo`
- `searxng`
- `jina`

示例：

```json
{
  "tools": {
    "web": {
      "proxy": "http://127.0.0.1:7890",
      "search": {
        "provider": "brave",
        "apiKey": "your-brave-api-key",
        "maxResults": 5
      }
    }
  }
}
```

### MCP

MCP 服务配置位于 `tools.mcpServers`。支持 `stdio`、`sse` 和 `streamableHttp`。

示例：通过 `npx` 启动一个 MCP Server

```json
{
  "tools": {
    "mcpServers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
        "toolTimeout": 30,
        "enabledTools": ["*"]
      }
    }
  }
}
```

### 工具安全

- `tools.restrictToWorkspace = true` 可以把工具访问限制在工作区内
- `tools.exec.timeout` 控制 Shell 工具超时时间
- `channels.allowFrom` 可限制允许与机器人交互的用户或群

## CLI 命令

常用命令如下：

| 命令 | 说明 |
| --- | --- |
| `nanobot onboard` | 初始化默认配置和工作区 |
| `nanobot onboard -c <config> -w <workspace>` | 初始化或刷新指定实例 |
| `nanobot agent` | 进入交互式聊天 |
| `nanobot agent -m "..."` | 单次对话 |
| `nanobot agent -w <workspace>` | 使用指定工作区 |
| `nanobot agent -c <config>` | 使用指定配置文件 |
| `nanobot agent --logs` | 聊天时显示运行日志 |
| `nanobot agent --no-markdown` | 纯文本输出 |
| `nanobot gateway` | 启动网关，接管已启用渠道 |
| `nanobot status` | 查看当前配置、Provider、渠道状态 |
| `nanobot channels login` | 登录渠道桥接服务，例如 WhatsApp |
| `nanobot channels status` | 查看渠道连接状态 |
| `nanobot provider login openai-codex` | Provider OAuth 登录 |

交互模式退出方式：

- `exit`
- `quit`
- `/exit`
- `/quit`
- `:q`
- `Ctrl + D`

## Docker 部署

项目已经提供 [`docker-compose.yml`](./docker-compose.yml) 和 [`Dockerfile`](./Dockerfile)。

### Docker Compose

首次初始化：

```bash
docker compose run --rm nanobot-cli onboard
```

编辑宿主机配置文件，填入 API Key：

```bash
vim ~/.nanobot/config.json
```

启动网关：

```bash
docker compose up -d nanobot-gateway
```

执行一次命令：

```bash
docker compose run --rm nanobot-cli agent -m "Hello!"
```

查看日志：

```bash
docker compose logs -f nanobot-gateway
```

停止：

```bash
docker compose down
```

### 直接使用 Docker

```bash
docker build -t nanobot .
docker run -v ~/.nanobot:/root/.nanobot --rm nanobot onboard
docker run -v ~/.nanobot:/root/.nanobot -p 18790:18790 nanobot gateway
docker run -v ~/.nanobot:/root/.nanobot --rm nanobot agent -m "Hello!"
docker run -v ~/.nanobot:/root/.nanobot --rm nanobot status
```

> `-v ~/.nanobot:/root/.nanobot` 会把容器内配置目录映射到宿主机，确保配置和工作区持久化。

## 周期任务与心跳

`nanobot gateway` 默认会周期性检查工作区中的 `HEARTBEAT.md`，用于执行周期任务或主动提醒。

初始化后会自动生成该文件。你可以直接编辑，或让 Agent 帮你维护。

示例：

```markdown
## Periodic Tasks

- [ ] 检查今天的天气并发送摘要
- [ ] 扫描收件箱中的紧急邮件
```

要使该功能生效，需要满足两个条件：

- 网关正在运行：`nanobot gateway`
- 机器人至少和你成功对话过一次，这样它知道该把结果回发到哪个渠道

## 项目结构

```text
nanobot/
├── agent/       # Agent 主循环、上下文、记忆、技能、子代理、内置工具
├── bus/         # 消息总线与事件
├── channels/    # 聊天渠道接入
├── cli/         # 命令行入口
├── config/      # 配置模型与加载逻辑
├── cron/        # 定时任务
├── heartbeat/   # 心跳唤醒
├── providers/   # LLM Provider 注册表与实现
├── session/     # 会话状态管理
├── skills/      # 内置技能
└── templates/   # 工作区模板与提示模板
```

仓库根目录下还有：

- `bridge/`：渠道桥接相关代码
- `docs/`：补充文档
- `tests/`：测试用例
- `case/`：演示图片和 GIF

## 开发与测试

安装开发依赖：

```bash
pip install -e .[dev]
```

运行测试：

```bash
pytest
```

运行代码检查：

```bash
ruff check .
```

如果你想扩展项目，通常最常见的入口有两个：

- 新增 Provider：修改 `nanobot/providers/registry.py` 和 `nanobot/config/schema.py`
- 新增 Channel：参考 [docs/CHANNEL_PLUGIN_GUIDE.md](./docs/CHANNEL_PLUGIN_GUIDE.md)

## 相关文档

- 英文原版说明：[README.md](./README.md)
- 渠道插件开发指南：[docs/CHANNEL_PLUGIN_GUIDE.md](./docs/CHANNEL_PLUGIN_GUIDE.md)
- 贡献指南：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 安全说明：[SECURITY.md](./SECURITY.md)
- 社区交流：[COMMUNICATION.md](./COMMUNICATION.md)

## 许可

本项目使用 [MIT License](./LICENSE)。
