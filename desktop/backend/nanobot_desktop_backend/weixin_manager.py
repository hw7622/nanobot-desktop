"""Desktop-side manager for the official built-in Weixin channel."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from nanobot.channels.weixin import MAX_QR_REFRESH_COUNT, WeixinChannel, WeixinConfig
from nanobot.config.paths import get_runtime_subdir

from nanobot_desktop_backend.config_manager import load_runtime_config


class WeixinManager:
    """Manages official built-in Weixin login state for the desktop shell."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._login_thread: threading.Thread | None = None
        self._login_cancel = threading.Event()
        self._login_session: dict[str, Any] | None = None

    def status(self, gateway_running: bool = False) -> dict[str, Any]:
        with self._lock:
            config = self._channel_config_unlocked()
            state_file = self._state_file_unlocked(config)
            account = self._read_json(state_file, {})
            login = dict(self._login_session) if self._login_session else None

        token = str(account.get("token") or "").strip()
        user_id = str(account.get("userId") or "").strip()
        bot_id = str(account.get("botId") or "").strip()
        base_url = str(account.get("base_url") or config.get("baseUrl") or "").strip()
        context_tokens = account.get("context_tokens") if isinstance(account, dict) else {}
        context_count = len(context_tokens) if isinstance(context_tokens, dict) else 0
        enabled = bool(config.get("enabled"))
        logged_in = bool(token)
        runtime_state = "运行中" if (gateway_running and enabled and logged_in) else ("待启动" if (enabled and logged_in) else ("待登录" if enabled else "未启用"))

        note = ""
        if enabled and not logged_in:
            note = "微信渠道已启用，但尚未登录。请先扫码登录，再启动或重启 Gateway。"
        elif logged_in and not enabled:
            note = "微信已登录。启用渠道并启动 Gateway 后即可接收消息。"
        elif login and login.get("status") in {"failed", "expired"}:
            note = str(login.get("error") or login.get("note") or "").strip()

        return {
            "supported": True,
            "installed": True,
            "enabled": enabled,
            "gatewayRunning": gateway_running,
            "runtimeState": runtime_state,
            "loggedIn": logged_in,
            "account": {
                "userId": user_id,
                "botId": bot_id,
                "baseUrl": base_url,
            },
            "contextCount": context_count,
            "stateDir": str(state_file.parent),
            "note": note,
            "login": login,
        }

    def start_login(self) -> dict[str, Any]:
        with self._lock:
            current = dict(self._login_session) if self._login_session else None
            if current and current.get("status") in {"pending", "scanned"}:
                return current

            self._login_cancel.set()
            self._login_cancel = threading.Event()
            login_id = uuid.uuid4().hex
            self._login_session = {
                "loginId": login_id,
                "status": "pending",
                "qrcode": "",
                "qrUrl": "",
                "createdAt": time.time(),
                "updatedAt": time.time(),
                "error": "",
            }
            self._login_thread = threading.Thread(
                target=self._run_login_thread,
                args=(login_id,),
                daemon=True,
                name="desktop-weixin-login",
            )
            self._login_thread.start()
            return dict(self._login_session)

    def login_status(self, login_id: str) -> dict[str, Any]:
        with self._lock:
            if not self._login_session or self._login_session.get("loginId") != login_id:
                raise RuntimeError("login_not_found")
            return dict(self._login_session)

    def logout(self) -> dict[str, Any]:
        with self._lock:
            self._login_cancel.set()
            config = self._channel_config_unlocked()
            state_file = self._state_file_unlocked(config)
            if state_file.exists():
                state_file.unlink()
            self._login_session = None
        return self.status(False)

    def cancel_login(self) -> None:
        with self._lock:
            self._login_cancel.set()

    def _run_login_thread(self, login_id: str) -> None:
        asyncio.run(self._run_login_flow(login_id))

    async def _run_login_flow(self, login_id: str) -> None:
        with self._lock:
            config_payload = self._channel_config_unlocked()
        channel = WeixinChannel(WeixinConfig.model_validate(config_payload), bus=None)
        channel._client = httpx.AsyncClient(
            timeout=httpx.Timeout(60, connect=30),
            follow_redirects=True,
        )
        channel._running = True
        refresh_count = 0

        try:
            qrcode_id, scan_url = await channel._fetch_qr_code()
            self._update_login_session(
                login_id,
                qrcode=qrcode_id,
                qrUrl=scan_url,
                status="pending",
            )

            while not self._login_cancel.is_set():
                try:
                    status_data = await channel._api_get(
                        "ilink/bot/get_qrcode_status",
                        params={"qrcode": qrcode_id},
                        auth=False,
                        extra_headers={"iLink-App-ClientVersion": "1"},
                    )
                except httpx.TimeoutException:
                    continue

                status = str(status_data.get("status") or "").strip()
                if status == "confirmed":
                    token = str(status_data.get("bot_token") or "").strip()
                    if not token:
                        self._update_login_session(login_id, status="failed", error="登录成功但未返回 bot_token。")
                        return
                    base_url = str(status_data.get("baseurl") or "").strip()
                    channel._token = token
                    if base_url:
                        channel.config.base_url = base_url
                    channel._save_state()
                    self._augment_saved_state(
                        channel,
                        user_id=str(status_data.get("ilink_user_id") or "").strip(),
                        bot_id=str(status_data.get("ilink_bot_id") or "").strip(),
                    )
                    self._update_login_session(
                        login_id,
                        status="confirmed",
                        userId=str(status_data.get("ilink_user_id") or "").strip(),
                    )
                    return

                if status == "scaned":
                    self._update_login_session(login_id, status="scanned")
                elif status == "expired":
                    refresh_count += 1
                    if refresh_count > MAX_QR_REFRESH_COUNT:
                        self._update_login_session(login_id, status="expired", error="二维码已过期，请重新生成。")
                        return
                    qrcode_id, scan_url = await channel._fetch_qr_code()
                    self._update_login_session(
                        login_id,
                        qrcode=qrcode_id,
                        qrUrl=scan_url,
                        status="pending",
                    )

                await asyncio.sleep(1)

            self._update_login_session(login_id, status="cancelled")
        except Exception as error:
            self._update_login_session(login_id, status="failed", error=str(error))
        finally:
            channel._running = False
            if channel._client is not None:
                await channel._client.aclose()
                channel._client = None

    def _update_login_session(self, login_id: str, **fields: Any) -> None:
        with self._lock:
            if not self._login_session or self._login_session.get("loginId") != login_id:
                return
            self._login_session.update(fields)
            self._login_session["updatedAt"] = time.time()

    def _augment_saved_state(self, channel: WeixinChannel, *, user_id: str, bot_id: str) -> None:
        state_file = channel._get_state_dir() / "account.json"
        data = self._read_json(state_file, {})
        if not isinstance(data, dict):
            data = {}
        if user_id:
            data["userId"] = user_id
        if bot_id:
            data["botId"] = bot_id
        if channel.config.base_url:
            data["base_url"] = channel.config.base_url
        state_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def _channel_config_unlocked(self) -> dict[str, Any]:
        try:
            payload = load_runtime_config().get("channels", {}).get("weixin", {})
        except Exception:
            payload = {}
        defaults = WeixinChannel.default_config()
        if not isinstance(payload, dict):
            return defaults
        merged = dict(defaults)
        merged.update(payload)
        return merged

    def _state_file_unlocked(self, config: dict[str, Any]) -> Path:
        state_dir = str(config.get("stateDir") or "").strip()
        if state_dir:
            base = Path(state_dir).expanduser()
            base.mkdir(parents=True, exist_ok=True)
            return base / "account.json"
        return get_runtime_subdir("weixin") / "account.json"

    @staticmethod
    def _read_json(path: Path, fallback: Any) -> Any:
        try:
            if not path.exists():
                return fallback
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return fallback
