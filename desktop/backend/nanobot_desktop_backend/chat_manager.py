"""Desktop-local chat manager for the desktop app."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any

from nanobot.agent.loop import AgentLoop
from nanobot.bus.queue import MessageBus
from nanobot.cli.commands import _make_provider
from nanobot.config.schema import Config
from nanobot.session.manager import SessionManager

from nanobot_desktop_backend.config_manager import load_core_runtime_config

logger = logging.getLogger("nanobot_desktop.chat")


class ChatManager:
    """Provides a lightweight desktop-local chat session for testing config."""

    SESSION_KEY = "desktop:console"
    CHANNEL_NAME = "desktop"
    CHAT_ID = "console"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._signature: str | None = None
        self._agent: AgentLoop | None = None
        self._bus: MessageBus | None = None
        self._sessions: SessionManager | None = None
        self._workspace: Path | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: threading.Thread | None = None
        self._loop_ready = threading.Event()
        self._shutdown = False

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        """Return the running background event loop, creating one if needed."""
        if self._loop is not None and self._loop.is_running():
            return self._loop

        self._loop = asyncio.new_event_loop()
        self._loop_ready.clear()
        self._loop_thread = threading.Thread(
            target=self._run_loop, daemon=True, name="chat-event-loop",
        )
        self._loop_thread.start()
        self._loop_ready.wait(timeout=10)
        return self._loop

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop_ready.set()
        self._loop.run_forever()

    def _submit(self, coro):
        """Submit a coroutine to the background event loop and block until done."""
        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=600)

    def shutdown(self) -> None:
        """Clean up the event loop and agent resources."""
        with self._lock:
            self._shutdown = True
            if self._agent is not None:
                try:
                    self._submit(self._agent.close_mcp())
                except Exception:
                    pass
                self._agent = None
            if self._loop is not None and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._loop.stop)
            if self._loop_thread is not None:
                self._loop_thread.join(timeout=5)
                self._loop_thread = None
            if self._loop is not None:
                pending = [t for t in self._loop._default_executor or []]
                self._loop.close()
            self._loop = None

    def history(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_sessions_unlocked()
            return self._history_unlocked(self.SESSION_KEY)

    def clear(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_sessions_unlocked()
            assert self._sessions is not None
            session = self._sessions.get_or_create(self.SESSION_KEY)
            session.clear()
            self._sessions.save(session)
            return []

    def send(
        self,
        content: str,
        *,
        session_key: str | None = None,
        channel: str = CHANNEL_NAME,
        chat_id: str = CHAT_ID,
    ) -> dict[str, Any]:
        message = (content or "").strip()
        if not message:
            raise ValueError("消息内容不能为空")

        resolved_session_key = (session_key or "").strip() or f"{channel}:{chat_id}"
        with self._lock:
            if self._shutdown:
                raise RuntimeError("ChatManager is shut down")
            self._ensure_agent_unlocked()
            assert self._agent is not None
            self._drain_outbound_unlocked()
            response = self._submit(
                self._agent.process_direct(
                    message,
                    session_key=resolved_session_key,
                    channel=channel,
                    chat_id=chat_id,
                )
            )
            outbound = self._drain_outbound_unlocked()
            return {
                "reply": response,
                "history": self._history_unlocked(resolved_session_key),
                "outbound": outbound,
            }

    def _history_unlocked(self, session_key: str) -> list[dict[str, Any]]:
        assert self._sessions is not None
        session = self._sessions.get_or_create(session_key)
        return [self._serialize_message(msg) for msg in session.messages]

    def _ensure_sessions_unlocked(self) -> None:
        payload = load_core_runtime_config()
        workspace = Config.model_validate(payload).workspace_path
        if self._sessions is None or self._workspace != workspace:
            self._sessions = SessionManager(workspace)
            self._workspace = workspace

    def _ensure_agent_unlocked(self) -> None:
        payload = load_core_runtime_config()
        signature = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        self._ensure_sessions_unlocked()
        if self._agent is not None and self._signature == signature:
            return

        if self._agent is not None:
            try:
                self._submit(self._agent.close_mcp())
            except Exception:
                pass

        config = Config.model_validate(payload)
        provider = _make_provider(config)
        assert self._sessions is not None
        bus = MessageBus()
        agent = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=config.workspace_path,
            model=config.agents.defaults.model,
            max_iterations=config.agents.defaults.max_tool_iterations,
            context_window_tokens=config.agents.defaults.context_window_tokens,
            web_search_config=config.tools.web.search,
            web_proxy=config.tools.web.proxy or None,
            exec_config=config.tools.exec,
            cron_service=None,
            restrict_to_workspace=config.tools.restrict_to_workspace,
            session_manager=self._sessions,
            mcp_servers=config.tools.mcp_servers,
            channels_config=config.channels,
        )
        self._signature = signature
        self._agent = agent
        self._bus = bus

    def _serialize_message(self, message: dict[str, Any]) -> dict[str, Any]:
        role = str(message.get("role") or "assistant")
        content = message.get("content", "")
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if text:
                        parts.append(str(text))
                elif item:
                    parts.append(str(item))
            text = "\n".join(parts)
        elif isinstance(content, dict):
            text = json.dumps(content, ensure_ascii=False, indent=2)
        else:
            text = str(content)
        return {
            "role": role,
            "content": text,
            "timestamp": message.get("timestamp", ""),
            "name": message.get("name", ""),
            "media": list(message.get("media") or []),
        }

    def _drain_outbound_unlocked(self) -> list[dict[str, Any]]:
        if self._bus is None:
            return []

        items: list[dict[str, Any]] = []
        while True:
            try:
                message = self._bus.outbound.get_nowait()
            except asyncio.QueueEmpty:
                break
            items.append({
                "channel": message.channel,
                "chatId": message.chat_id,
                "content": str(message.content or ""),
                "media": list(message.media or []),
                "metadata": dict(message.metadata or {}),
            })
        return items
