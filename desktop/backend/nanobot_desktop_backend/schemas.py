"""GUI schema metadata for the desktop app."""

from __future__ import annotations

from typing import Any

from nanobot.providers.registry import find_by_name


PROVIDERS = {
    "openrouter": "OpenRouter",
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "deepseek": "DeepSeek",
    "dashscope": "通义千问",
    "gemini": "Gemini",
    "moonshot": "Kimi",
    "zhipu": "智谱 GLM",
    "ollama": "Ollama",
    "custom": "自定义兼容接口",
}

CHANNELS = {
    "telegram": "Telegram",
    "weixin": "微信",
    "feishu": "飞书",
    "dingtalk": "钉钉",
    "email": "Email",
    "qq": "QQ",
    "wecom": "企业微信",
}

CHANNEL_DEFAULTS = {
    "telegram": {
        "enabled": False,
        "token": "",
        "allowFrom": [],
        "proxy": None,
        "replyToMessage": False,
        "groupPolicy": "mention",
    },
    "weixin": {
        "enabled": False,
        "allowFrom": ["*"],
        "baseUrl": "https://ilinkai.weixin.qq.com",
        "routeTag": "",
        "pollTimeout": 35,
    },
    "feishu": {
        "enabled": False,
        "appId": "",
        "appSecret": "",
        "encryptKey": "",
        "verificationToken": "",
        "allowFrom": [],
    },
    "dingtalk": {
        "enabled": False,
        "clientId": "",
        "clientSecret": "",
        "robotCode": "",
        "allowFrom": [],
    },
    "email": {
        "enabled": False,
        "consentGranted": False,
        "imapHost": "",
        "imapPort": 993,
        "imapUsername": "",
        "imapPassword": "",
        "imapMailbox": "INBOX",
        "imapUseSsl": True,
        "smtpHost": "",
        "smtpPort": 587,
        "smtpUsername": "",
        "smtpPassword": "",
        "smtpUseTls": True,
        "smtpUseSsl": False,
        "fromAddress": "",
        "autoReplyEnabled": True,
        "pollIntervalSeconds": 30,
        "markSeen": True,
        "maxBodyChars": 12000,
        "subjectPrefix": "Re: ",
        "allowFrom": [],
    },
    "qq": {
        "enabled": False,
        "appId": "",
        "secret": "",
        "allowFrom": [],
        "msgFormat": "plain",
    },
    "wecom": {
        "enabled": False,
        "botId": "",
        "secret": "",
        "allowFrom": [],
        "welcomeMessage": "",
    },
}

CHANNEL_FIELD_META = {
    "telegram": [
        {"key": "enabled", "label": "启用 Telegram", "type": "toggle"},
        {"key": "token", "label": "Bot Token", "type": "password", "required": True},
        {"key": "allowFrom", "label": "允许访问的用户", "type": "list", "placeholder": "用户 ID 或用户名"},
        {"key": "proxy", "label": "代理", "type": "text", "placeholder": "http://127.0.0.1:7890"},
        {"key": "replyToMessage", "label": "回复原消息", "type": "toggle"},
        {
            "key": "groupPolicy",
            "label": "群聊策略",
            "type": "select",
            "options": [
                {"label": "仅响应 @ 机器人", "value": "mention"},
                {"label": "直接接收群消息", "value": "open"},
            ],
        },
    ],
    "weixin": [
        {"key": "enabled", "label": "启用微信", "type": "toggle"},
        {"key": "allowFrom", "label": "允许访问的用户", "type": "list", "placeholder": "* 表示允许所有联系人"},
        {"key": "baseUrl", "label": "微信服务地址", "type": "text"},
        {"key": "routeTag", "label": "路由标签", "type": "text", "placeholder": "留空使用默认路由"},
        {"key": "pollTimeout", "label": "轮询超时(秒)", "type": "number"},
    ],
    "feishu": [
        {"key": "enabled", "label": "启用飞书", "type": "toggle"},
        {"key": "appId", "label": "App ID", "type": "text", "required": True},
        {"key": "appSecret", "label": "App Secret", "type": "password", "required": True},
        {"key": "encryptKey", "label": "Encrypt Key", "type": "password"},
        {"key": "verificationToken", "label": "Verification Token", "type": "password"},
        {"key": "allowFrom", "label": "允许访问的用户", "type": "list"},
    ],
    "dingtalk": [
        {"key": "enabled", "label": "启用钉钉", "type": "toggle"},
        {"key": "clientId", "label": "Client ID / App Key", "type": "text", "required": True},
        {"key": "clientSecret", "label": "Client Secret", "type": "password", "required": True},
        {"key": "robotCode", "label": "Robot Code", "type": "text"},
        {"key": "allowFrom", "label": "允许访问的用户", "type": "list"},
    ],
    "email": [
        {"key": "enabled", "label": "启用 Email", "type": "toggle"},
        {"key": "consentGranted", "label": "已获得收件授权", "type": "toggle"},
        {"key": "imapHost", "label": "IMAP Host", "type": "text"},
        {"key": "imapPort", "label": "IMAP Port", "type": "number"},
        {"key": "imapUsername", "label": "IMAP 用户名", "type": "text"},
        {"key": "imapPassword", "label": "IMAP 密码", "type": "password"},
        {"key": "smtpHost", "label": "SMTP Host", "type": "text"},
        {"key": "smtpPort", "label": "SMTP Port", "type": "number"},
        {"key": "smtpUsername", "label": "SMTP 用户名", "type": "text"},
        {"key": "smtpPassword", "label": "SMTP 密码", "type": "password"},
        {"key": "fromAddress", "label": "发件地址", "type": "text"},
        {"key": "allowFrom", "label": "允许访问的邮箱", "type": "list"},
    ],
    "qq": [
        {"key": "enabled", "label": "启用 QQ", "type": "toggle"},
        {"key": "appId", "label": "App ID", "type": "text", "required": True},
        {"key": "secret", "label": "Secret", "type": "password", "required": True},
        {"key": "allowFrom", "label": "允许访问的用户", "type": "list"},
        {
            "key": "msgFormat",
            "label": "消息格式",
            "type": "select",
            "options": [
                {"label": "纯文本", "value": "plain"},
                {"label": "Markdown", "value": "markdown"},
            ],
        },
    ],
    "wecom": [
        {"key": "enabled", "label": "启用企业微信", "type": "toggle"},
        {"key": "botId", "label": "Bot ID", "type": "text", "required": True},
        {"key": "secret", "label": "Secret", "type": "password", "required": True},
        {"key": "allowFrom", "label": "允许访问的用户", "type": "list"},
        {"key": "welcomeMessage", "label": "欢迎语", "type": "textarea"},
    ],
}

PROVIDER_FIELD_META = {
    "openrouter": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "anthropic": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "openai": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "deepseek": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "dashscope": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "gemini": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "moonshot": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "zhipu": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text"},
    ],
    "ollama": [
        {"key": "apiBase", "label": "API Base", "type": "text", "required": True, "placeholder": "http://localhost:11434"},
    ],
    "custom": [
        {"key": "apiKey", "label": "API Key", "type": "password", "required": True},
        {"key": "apiBase", "label": "API Base", "type": "text", "required": True},
        {"key": "extraHeaders", "label": "额外请求头", "type": "json"},
    ],
}

AGENT_FIELDS = [
    {"key": "provider", "label": "默认供应商", "type": "select-provider"},
    {"key": "model", "label": "默认模型", "type": "text", "required": True},
    {"key": "workspace", "label": "工作区", "type": "text"},
    {"key": "maxTokens", "label": "Max Tokens", "type": "number"},
    {"key": "contextWindowTokens", "label": "上下文窗口", "type": "number"},
    {"key": "temperature", "label": "Temperature", "type": "number", "step": 0.1},
    {"key": "maxToolIterations", "label": "工具迭代上限", "type": "number"},
    {
        "key": "reasoningEffort",
        "label": "推理强度",
        "type": "select",
        "options": [
            {"label": "自动", "value": ""},
            {"label": "low", "value": "low"},
            {"label": "medium", "value": "medium"},
            {"label": "high", "value": "high"},
        ],
    },
]

TOOLS_FIELDS = {
    "web": [
        {"key": "proxy", "label": "Web 代理", "type": "text", "placeholder": "http://127.0.0.1:7890"},
        {
            "key": "search.provider",
            "label": "搜索 Provider",
            "type": "select",
            "options": [
                {"label": "Brave", "value": "brave"},
                {"label": "Tavily", "value": "tavily"},
                {"label": "DuckDuckGo", "value": "duckduckgo"},
                {"label": "SearXNG", "value": "searxng"},
                {"label": "Jina", "value": "jina"},
            ],
        },
        {"key": "search.apiKey", "label": "搜索 API Key", "type": "password"},
        {"key": "search.baseUrl", "label": "搜索 Base URL", "type": "text"},
        {"key": "search.maxResults", "label": "最大结果数", "type": "number"},
    ],
    "exec": [
        {"key": "timeout", "label": "命令超时（秒）", "type": "number"},
        {"key": "pathAppend", "label": "附加 PATH", "type": "text"},
    ],
    "root": [
        {"key": "restrictToWorkspace", "label": "仅允许访问工作区", "type": "toggle"},
    ],
}


def default_config_payload(workspace: str) -> dict[str, Any]:
    return {
        "agents": {
            "defaults": {
                "workspace": workspace,
                "model": "anthropic/claude-opus-4-5",
                "provider": "openrouter",
                "maxTokens": 8192,
                "contextWindowTokens": 65536,
                "temperature": 0.1,
                "maxToolIterations": 40,
                "reasoningEffort": None,
            }
        },
        "channels": {
            "sendProgress": True,
            "sendToolHints": False,
            **CHANNEL_DEFAULTS,
        },
        "providers": {
            name: {"apiKey": "", "apiBase": None, "extraHeaders": None}
            for name in PROVIDERS
        },
        "gateway": {
            "host": "0.0.0.0",
            "port": 18790,
            "heartbeat": {"enabled": True, "intervalS": 1800},
        },
        "tools": {
            "web": {
                "proxy": None,
                "search": {
                    "provider": "brave",
                    "apiKey": "",
                    "baseUrl": "",
                    "maxResults": 5,
                },
            },
            "exec": {"timeout": 60, "pathAppend": ""},
            "restrictToWorkspace": False,
            "mcpServers": {},
        },
    }


def build_schema() -> dict[str, Any]:
    return {
        "providers": [
            {
                "key": key,
                "label": label,
                "fields": PROVIDER_FIELD_META[key],
                "defaultApiBase": (find_by_name(key).default_api_base if find_by_name(key) else ""),
            }
            for key, label in PROVIDERS.items()
        ],
        "channels": [
            {
                "key": key,
                "label": label,
                "defaultConfig": CHANNEL_DEFAULTS[key],
                "fields": CHANNEL_FIELD_META[key],
            }
            for key, label in CHANNELS.items()
        ],
        "agents": AGENT_FIELDS,
        "tools": TOOLS_FIELDS,
        "mcpServerTemplate": {
            "type": "stdio",
            "command": "",
            "args": [],
            "env": {},
            "url": "",
            "headers": {},
            "toolTimeout": 30,
            "enabledTools": ["*"],
        },
    }
