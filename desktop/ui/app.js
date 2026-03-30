const tabs = [
  { id: "dashboard", short: "DB", label: "仪表盘", hint: "核心状态、控制与启动行为" },
  { id: "ai", short: "AI", label: "AI 配置", hint: "Provider、模型与高级参数" },
  { id: "channels", short: "CN", label: "渠道配置", hint: "Telegram、飞书等入口开关" },
  { id: "skills", short: "SK", label: "技能库", hint: "技能卡片与工作区目录" },
  { id: "logs", short: "LG", label: "实时日志", hint: "全屏查看聚合日志" },
];

const API_BASE = (() => {
  if (typeof window !== "undefined" && typeof window.__NANOBOT_API_BASE__ === "string") return window.__NANOBOT_API_BASE__;
  if (typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost") && location.port === "18791") return "";
  return "http://127.0.0.1:18791";
})();

const TAURI_INVOKE = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
const TAURI_WINDOW = window.__TAURI__?.webviewWindow || window.__TAURI__?.window;
const BUILTIN_SKILL_DESCRIPTION_ZH = {
  clawhub: "从 ClawHub 公共技能仓库中搜索并安装技能。",
  cron: "安排提醒、定时任务和周期任务。",
  github: "使用 GitHub CLI 处理仓库、Issue、PR、Actions 和 API。",
  memory: "双层记忆系统，用于长期记忆和历史检索。",
  "skill-creator": "创建或更新技能包。",
  summarize: "总结或提取链接、视频和本地文件内容。",
  tmux: "管理 tmux 会话和终端窗口。",
  weather: "查询天气和天气预报。",
};

const state = {
  tab: "dashboard",
  isMainNavVisible: true,
  channelExpanded: {},
  bootstrap: null,
  draft: null,
  bootstrapError: "",
  provider: "openrouter",
  logs: [],
  sessions: [],
  selectedSessionKey: "",
  selectedSession: null,
  selectedSessionItems: [],
  chatDraft: "",
  chatBusy: false,
  gatewayBusy: "",
  saveBusy: false,
  saveRestartBusy: false,
  lastSaveMessage: "",
  restartRecommended: false,
  updaterBusy: "",
  updater: fallbackUpdaterState("等待更新状态"),
  autoLaunchSupported: false,
  autoLaunchEnabled: false,
  autoLaunchBusy: false,
  autoLaunchNote: "",
  logStickBottom: true,
  logScrollTop: 0,
  logPath: "",
  logLineCount: 0,
  logUpdatedAt: 0,
  logLastRefreshAt: 0,
  logSelectionPaused: false,
  logRefreshBusy: false,
  logSource: "all",
  chatStickBottom: true,
  chatScrollTop: 0,
  pageScrollTops: {},
  aiAdvancedOpen: false,
  weixinLogin: null,
  weixinBusy: "",
  chatRefreshBusy: false,
  chatManualRefreshBusy: false,
  chatRefreshQueued: false,
  chatRefreshQueuedManual: false,
  sessionActionBusy: "",
  closePromptOpen: false,
  closePromptBypass: false,
  imagePreview: null,
  dialog: null,
};

let refreshHandle = 0;
let refreshIntervalMs = 0;
let refreshListenersBound = false;
let weixinLoginPollHandle = 0;
let dialogResolver = null;

const els = {
  shell: document.querySelector(".shell"),
  nav: document.getElementById("nav"),
  content: document.getElementById("content"),
  title: document.getElementById("pageTitle"),
  saveBtn: document.getElementById("saveBtn"),
  saveRestartBtn: document.getElementById("saveRestartBtn"),
  saveState: document.getElementById("saveState"),
  gatewayDot: document.getElementById("gatewayDot"),
  gatewayLabel: document.getElementById("gatewayLabel"),
  versionMeta: document.getElementById("versionMeta"),
  closePromptLayer: document.getElementById("closePromptLayer"),
};

init();

async function init() {
  bindWindowCloseHandler();
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.imagePreview) closeImagePreview();
    if (event.key === "Escape" && state.dialog) resolveDialog({ confirmed: false, value: null });
  });
  els.saveBtn.addEventListener("click", () => saveConfig({ restartAfterSave: false }));
  els.saveRestartBtn.addEventListener("click", () => saveConfig({ restartAfterSave: true }));
  renderShellLoading();
  try {
    await refreshBootstrapWithRetry();
    await refreshUpdaterState(false);
    await refreshAutoLaunchState(false);
    ensurePollingStarted();
    render();
  } catch (error) {
    state.bootstrapError = describeBootstrapError(error);
    renderShellLoading();
    scheduleBootstrapRetry();
  }
}

async function refreshBootstrapWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await refreshBootstrap();
      state.bootstrapError = "";
      return;
    } catch (error) {
      lastError = error;
      state.bootstrapError = `正在等待桌面后端启动（第 ${attempt} 次）`;
      renderShellLoading();
      await sleep(1000);
    }
  }
  throw lastError || new Error("无法连接桌面后端");
}

function scheduleBootstrapRetry() {
  window.setTimeout(async () => {
    try {
      await refreshBootstrapWithRetry();
      await refreshUpdaterState(false);
      await refreshAutoLaunchState(false);
      ensurePollingStarted();
      render();
    } catch (error) {
      state.bootstrapError = describeBootstrapError(error);
      renderShellLoading();
      scheduleBootstrapRetry();
    }
  }, 3000);
}

function describeBootstrapError(error) {
  const raw = String(error?.message || error || "").trim();
  if (!raw || raw === "Failed to fetch") return "桌面后端仍在启动，请稍候。";
  return `桌面后端启动失败：${raw}`;
}

async function refreshBootstrap() {
  const payload = await fetchJson("/api/bootstrap");
  state.bootstrap = payload;
  state.draft = clone(payload.config);
  ensureDesktopConfig(state.bootstrap.config);
  ensureDesktopConfig(state.draft);
  state.provider = state.draft.agents.defaults.provider || "openrouter";
  applyWeixinStatus(payload.weixin || {});
  await refreshLogs();
  await refreshSessions();
  if (!state.selectedSessionKey && state.sessions.length) state.selectedSessionKey = defaultSessionKey(state.sessions);
  await refreshSelectedSession();
}

async function refreshRuntime() {
  if (!state.bootstrap) return;
  captureLogScroll();
  try {
    const payload = await fetchJson("/api/bootstrap");
    state.bootstrap.status = payload.status;
    state.bootstrap.meta = payload.meta;
    state.bootstrap.skills = payload.skills;
    state.bootstrap.config = payload.config;
    ensureDesktopConfig(state.bootstrap.config);
    applyWeixinStatus(payload.weixin || {});
    await refreshLogs();
    renderHeader();
    if (state.tab === "logs") updateLogsView();
    else if (["dashboard", "skills", "channels"].includes(state.tab)) renderBody();
  } catch (error) {
    state.bootstrapError = `状态刷新失败：${error.message || error}`;
    renderHeader();
  }
}

function bindWindowCloseHandler() {
  const openClosePrompt = () => {
    if (state.closePromptBypass || state.closePromptOpen || state.dialog || state.imagePreview) return;
    state.closePromptOpen = true;
    renderOverlayLayer();
  };

  window.__NANOBOT_OPEN_CLOSE_PROMPT__ = openClosePrompt;
  window.__NANOBOT_SUBMIT_CLOSE_ACTION__ = (action) => submitCloseAction(action);

  const currentWindow = TAURI_WINDOW?.getCurrentWebviewWindow?.() || TAURI_WINDOW?.getCurrentWindow?.();
  if (!currentWindow?.onCloseRequested) return;
  Promise.resolve(currentWindow.onCloseRequested((event) => {
    event?.preventDefault?.();
    openClosePrompt();
  })).catch(() => {});
}

async function refreshChatData(options = {}) {
  const force = Boolean(options.force);
  const manual = Boolean(options.manual);
  if (!state.bootstrap) return;
  if (state.chatRefreshBusy) {
    if (force) {
      state.chatRefreshQueued = true;
      state.chatRefreshQueuedManual = state.chatRefreshQueuedManual || manual;
      if (manual) {
        state.chatManualRefreshBusy = true;
        if (state.tab === "chat") renderChatPagePartial({ preserveInput: true });
      }
    }
    return;
  }
  state.chatRefreshBusy = true;
  if (manual) {
    state.chatManualRefreshBusy = true;
    if (state.tab === "chat") renderChatPagePartial({ preserveInput: true });
  }
  captureChatScroll();
  try {
    await refreshSessions();
    await refreshSelectedSession();
    renderHeader();
  } catch (error) {
    state.bootstrapError = `聊天刷新失败：${error.message || error}`;
    renderHeader();
  } finally {
    state.chatRefreshBusy = false;
    const queued = state.chatRefreshQueued;
    const queuedManual = state.chatRefreshQueuedManual;
    state.chatRefreshQueued = false;
    state.chatRefreshQueuedManual = false;
    if (!queued) state.chatManualRefreshBusy = false;
    if (state.tab === "chat") renderChatPagePartial({ preserveInput: true });
    if (queued) void refreshChatData({ force: true, manual: queuedManual });
  }
}

function ensurePollingStarted() {
  const nextIntervalMs = currentRefreshIntervalMs();
  if (refreshHandle && refreshIntervalMs === nextIntervalMs) return;
  if (refreshHandle) window.clearInterval(refreshHandle);
  refreshIntervalMs = nextIntervalMs;
  refreshHandle = window.setInterval(() => void refreshVisibleData(), nextIntervalMs);
  if (!refreshListenersBound) {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void refreshVisibleData();
    });
    window.addEventListener("focus", () => void refreshVisibleData());
    refreshListenersBound = true;
  }
}

async function refreshVisibleData() {
  if (state.tab === "chat") {
    await refreshChatData();
    return;
  }
  await refreshRuntime();
}

async function refreshLogs() {
  const payload = await fetchJson(`/api/logs?name=${encodeURIComponent(state.logSource || "all")}&lines=1000`);
  state.logs = payload.lines || [];
  state.logPath = payload.path || "";
  state.logLineCount = Number(payload.lineCount || 0);
  state.logUpdatedAt = payload.updatedAt ? Number(payload.updatedAt) * 1000 : 0;
  state.logLastRefreshAt = Date.now();
  if (state.bootstrap?.status) state.bootstrap.status.logArchives = payload.archives || [];
}

async function refreshSessions() {
  const payload = await fetchJson("/api/sessions");
  state.sessions = payload.items || [];
  if (!state.sessions.some((item) => item.key === state.selectedSessionKey)) {
    state.selectedSessionKey = defaultSessionKey(state.sessions);
  }
  state.selectedSession = state.sessions.find((item) => item.key === state.selectedSessionKey) || null;
}

async function refreshSelectedSession() {
  if (!state.selectedSessionKey) {
    state.selectedSession = null;
    state.selectedSessionItems = [];
    return;
  }
  try {
    const payload = await fetchJson(`/api/session?key=${encodeURIComponent(state.selectedSessionKey)}`);
    state.selectedSession = payload.session || state.sessions.find((item) => item.key === state.selectedSessionKey) || null;
    state.selectedSessionItems = payload.items || [];
  } catch {
    state.selectedSession = state.sessions.find((item) => item.key === state.selectedSessionKey) || null;
    state.selectedSessionItems = [];
  }
}

async function refreshUpdaterState(renderAfter = true) {
  if (!TAURI_INVOKE) {
    state.updater = fallbackUpdaterState("当前调试模式不接入自动更新。");
    if (renderAfter) render();
    return;
  }
  try {
    state.updater = await invokeTauri("updater_status");
  } catch (error) {
    state.updater = fallbackUpdaterState(`读取更新状态失败：${error.message || error}`);
  }
  if (renderAfter) render();
}

async function refreshAutoLaunchState(renderAfter = true) {
  if (!TAURI_INVOKE) {
    state.autoLaunchSupported = false;
    state.autoLaunchEnabled = false;
    state.autoLaunchNote = "当前调试模式不显示系统自启动状态。";
    if (renderAfter) render();
    return;
  }
  try {
    applyAutoLaunchPayload(await invokeTauri("autostart_status"));
  } catch (error) {
    state.autoLaunchSupported = false;
    state.autoLaunchEnabled = false;
    state.autoLaunchNote = `读取开机自启动失败：${error.message || error}`;
  }
  if (renderAfter) render();
}

async function setAutoLaunch(enabled) {
  if (!TAURI_INVOKE || state.autoLaunchBusy) return;
  state.autoLaunchBusy = true;
  renderBody();
  try {
    applyAutoLaunchPayload(await invokeTauri("set_autostart", { enabled }));
    state.lastSaveMessage = enabled ? "已开启桌面程序开机自启动。" : "已关闭桌面程序开机自启动。";
  } catch (error) {
    state.autoLaunchNote = `设置开机自启动失败：${error.message || error}`;
  } finally {
    state.autoLaunchBusy = false;
    render();
  }
}

function applyAutoLaunchPayload(payload) {
  state.autoLaunchSupported = Boolean(payload?.supported);
  state.autoLaunchEnabled = Boolean(payload?.enabled);
  state.autoLaunchNote = payload?.note || "";
  if (state.bootstrap?.config) ensureDesktopConfig(state.bootstrap.config).app.autoLaunch = state.autoLaunchEnabled;
  if (state.draft) ensureDesktopConfig(state.draft).app.autoLaunch = state.autoLaunchEnabled;
}

async function saveConfig({ restartAfterSave }) {
  if (!state.draft || state.saveBusy || state.saveRestartBusy) return;
  if (!isDirty() && !restartAfterSave) return;
  if (restartAfterSave) state.saveRestartBusy = true;
  else state.saveBusy = true;
  renderHeader();
  try {
    const payload = await fetchJson("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.draft),
    });
    state.bootstrap.config = payload.config;
    state.bootstrap.skills = payload.skills;
    state.draft = clone(payload.config);
    ensureDesktopConfig(state.bootstrap.config);
    ensureDesktopConfig(state.draft);
    ensurePollingStarted();
    if (restartAfterSave) {
      await gatewayAction(state.bootstrap.status.running ? "restart" : "start", false);
      state.lastSaveMessage = "配置已保存，并已重启 Gateway。";
      state.restartRecommended = false;
    } else {
      state.lastSaveMessage = "配置已保存。涉及模型、渠道、MCP 的改动建议重启 Gateway。";
      state.restartRecommended = true;
    }
  } finally {
    state.saveBusy = false;
    state.saveRestartBusy = false;
    render();
  }
}

async function gatewayAction(action, renderAfter = true) {
  if (!state.bootstrap || state.gatewayBusy) return;
  state.gatewayBusy = action;
  renderBody();
  try {
    const payload = await fetchJson(`/api/gateway/${action}`, { method: "POST" });
    state.bootstrap.status = payload.status;
    await refreshWeixinStatus(false);
    await refreshLogs();
    if (action === "restart" || action === "start") {
      state.restartRecommended = false;
      if (!isDirty()) state.lastSaveMessage = "Gateway 已加载当前配置。";
    } else if (action === "stop") {
      state.lastSaveMessage = "Gateway 已停止。";
    }
  } catch (error) {
    state.lastSaveMessage = `Gateway ${action} 失败：${error.message || error}`;
  } finally {
    state.gatewayBusy = "";
  }
  if (renderAfter) render();
}

async function persistDraftConfig() {
  const payload = await fetchJson("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.draft),
  });
  state.bootstrap.config = payload.config;
  state.bootstrap.skills = payload.skills;
  state.draft = clone(payload.config);
  ensureDesktopConfig(state.bootstrap.config);
  ensureDesktopConfig(state.draft);
  ensurePollingStarted();
  return payload;
}

async function checkUpdates() {
  if (!TAURI_INVOKE || state.updaterBusy) return;
  state.updaterBusy = "check";
  renderBody();
  try {
    state.updater = await invokeTauri("check_for_updates");
  } catch (error) {
    const raw = String(error?.message || error || "");
    const note = raw.includes("Could not fetch a valid release JSON from the remote")
      ? "检查更新失败：GitHub 上还没有可用的 latest.json，当前更新地址返回 404。"
      : `检查更新失败：${raw}`;
    state.updater = fallbackUpdaterState(note);
  } finally {
    state.updaterBusy = "";
    renderBody();
  }
}

async function installUpdate() {
  if (!TAURI_INVOKE || state.updaterBusy) return;
  state.updaterBusy = "install";
  renderBody();
  try {
    state.updater = await invokeTauri("install_update");
    state.lastSaveMessage = "更新已安装，关闭桌面端后重新打开即可。";
  } catch (error) {
    state.updater = fallbackUpdaterState(`安装更新失败：${error.message || error}`);
  } finally {
    state.updaterBusy = "";
    render();
  }
}

async function sendChatMessage() {
  if (state.chatBusy || state.selectedSessionKey !== "desktop:console") return;
  const content = state.chatDraft.trim();
  if (!content) return;
  state.chatBusy = true;
  renderBody();
  try {
    const payload = await fetchJson("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    state.selectedSessionItems = payload.history || [];
    state.chatDraft = "";
    state.chatStickBottom = true;
    await refreshSessions();
  } catch (error) {
    await showAlertDialog(`发送失败：${error.message || error}`, { title: "发送失败" });
  } finally {
    state.chatBusy = false;
    renderChatPagePartial({ preserveInput: true });
  }
}

async function clearChatHistory() {
  if (state.chatBusy || state.selectedSessionKey !== "desktop:console") return;
  if (!await showConfirmDialog("确定清空桌面测试会话吗？", { title: "清空测试会话" })) return;
  state.chatBusy = true;
  renderChatPagePartial({ preserveInput: true });
  try {
    const payload = await fetchJson("/api/chat/clear", { method: "POST" });
    state.selectedSessionItems = payload.items || [];
    state.chatStickBottom = true;
  } finally {
    state.chatBusy = false;
    renderChatPagePartial({ preserveInput: true });
  }
}

async function createSkill() {
  const name = await showPromptDialog({
    title: "新建 Skill",
    message: "请输入新 Skill 名称",
    placeholder: "skill-name",
  });
  if (!name) return;
  try {
    const payload = await fetchJson("/api/skill/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    state.bootstrap.skills = payload.skills;
    state.lastSaveMessage = `已创建 Skill：${payload.created.name}`;
    render();
  } catch (error) {
    await showAlertDialog(`创建 Skill 失败：${error.message || error}`, { title: "创建 Skill 失败" });
  }
}

async function deleteSkill(name) {
  if (!await showConfirmDialog(`确定删除 Skill '${name}' 吗？`, { title: "删除 Skill" })) return;
  try {
    const payload = await fetchJson("/api/skill/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    state.bootstrap.skills = payload.skills;
    state.lastSaveMessage = `已删除 Skill：${name}`;
    render();
  } catch (error) {
    await showAlertDialog(`删除 Skill 失败：${error.message || error}`, { title: "删除 Skill 失败" });
  }
}

async function openTarget(target) {
  try {
    await fetchJson("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
  } catch (error) {
    await showAlertDialog(`打开失败：${error.message || error}`, { title: "打开失败" });
  }
}

function qrImageUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(String(value || ""))}`;
}

async function refreshWeixinStatus(renderAfter = true) {
  const payload = await fetchJson("/api/weixin/status");
  applyWeixinStatus(payload.status || {});
  if (renderAfter) renderBody();
}

function applyWeixinStatus(status) {
  const nextStatus = status && typeof status === "object" ? status : {};
  if (state.bootstrap) state.bootstrap.weixin = nextStatus;
  const login = nextStatus.login && typeof nextStatus.login === "object" ? clone(nextStatus.login) : null;
  state.weixinLogin = login;
  if (login && ["pending", "scanned"].includes(login.status)) startWeixinLoginPolling();
  else stopWeixinLoginPolling();
}

function weixinStateText(status) {
  const current = status && typeof status === "object" ? status : {};
  if (current.runtimeState) return current.runtimeState;
  if (current.loggedIn && current.enabled) return "待启动";
  if (current.enabled) return "待登录";
  return "未启用";
}

async function clearSelectedSession() {
  const sessionKey = String(state.selectedSessionKey || "").trim();
  if (!sessionKey || state.chatBusy || state.sessionActionBusy) return;
  const isDesktop = sessionKey === "desktop:console";
  const label = state.selectedSession?.title || sessionKey;
  if (!await showConfirmDialog(`确定清空会话“${label}”吗？`, { title: "清空会话" })) return;
  state.sessionActionBusy = "clear";
  renderChatPagePartial({ preserveInput: true });
  try {
    if (isDesktop) {
      const payload = await fetchJson("/api/chat/clear", { method: "POST" });
      state.selectedSessionItems = payload.items || [];
    } else {
      const payload = await fetchJson("/api/session/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: sessionKey }),
      });
      state.selectedSession = payload.session || state.selectedSession;
      state.selectedSessionItems = payload.items || [];
    }
    state.chatStickBottom = true;
    await refreshSessions();
    await refreshSelectedSession();
  } catch (error) {
    await showAlertDialog(`清空会话失败：${error.message || error}`, { title: "清空会话失败" });
  } finally {
    state.sessionActionBusy = "";
    renderChatPagePartial({ preserveInput: true });
  }
}

async function deleteSelectedSession() {
  const sessionKey = String(state.selectedSessionKey || "").trim();
  if (!sessionKey || sessionKey === "desktop:console" || state.chatBusy || state.sessionActionBusy) return;
  const label = state.selectedSession?.title || sessionKey;
  if (!await showConfirmDialog(`确定删除会话“${label}”吗？删除后会从列表中移除。`, { title: "删除会话" })) return;
  state.sessionActionBusy = "delete";
  renderChatPagePartial({ preserveInput: true });
  try {
    await fetchJson("/api/session/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: sessionKey }),
    });
    await refreshSessions();
    await refreshSelectedSession();
    state.chatStickBottom = true;
  } catch (error) {
    await showAlertDialog(`删除会话失败：${error.message || error}`, { title: "删除会话失败" });
  } finally {
    state.sessionActionBusy = "";
    renderChatPagePartial({ preserveInput: true });
  }
}

async function weixinAction(action, payload = null) {
  if (state.weixinBusy) return;
  state.weixinBusy = action;
  renderBody();
  try {
    if (action === "startLogin") {
      const result = await fetchJson("/api/weixin/login/start", { method: "POST" });
      state.weixinLogin = { ...result, status: result.status || "pending" };
      startWeixinLoginPolling();
      state.lastSaveMessage = result.qrUrl ? "已生成微信二维码。" : "正在生成微信二维码...";
    } else if (action === "logout") {
      await fetchJson("/api/weixin/logout", { method: "POST" });
      stopWeixinLoginPolling();
      state.weixinLogin = null;
      await refreshWeixinStatus(false);
      if ((state.draft.channels.weixin || {}).enabled && state.bootstrap.status.running) {
        await gatewayAction("restart", false);
        await refreshWeixinStatus(false);
        state.lastSaveMessage = state.bootstrap.status.running
          ? "微信已退出登录，并已重启 Gateway。"
          : "微信已退出登录，但 Gateway 重启失败，请手动处理。";
      } else {
        state.lastSaveMessage = "微信登录状态已清空。";
      }
    } else if (action === "refresh") {
      await refreshWeixinStatus(false);
    }
    renderHeader();
    renderBody();
  } catch (error) {
    const message = String(error?.message || error || "");
    if (message.includes("login_not_found")) {
      stopWeixinLoginPolling();
      state.weixinLogin = null;
      state.lastSaveMessage = "二维码会话已失效，请重新扫码登录。";
      renderHeader();
      renderBody();
      return;
    }
    await showAlertDialog(`微信操作失败：${message}`, { title: "微信操作失败" });
    renderBody();
  } finally {
    state.weixinBusy = "";
    renderBody();
  }
}

function stopWeixinLoginPolling() {
  if (weixinLoginPollHandle) window.clearTimeout(weixinLoginPollHandle);
  weixinLoginPollHandle = 0;
}

async function syncWeixinEnabled(enabled) {
  if (state.weixinBusy || !state.draft) return;
  const previousDraft = clone(state.draft);
  applyValue("channels.weixin.enabled", enabled);
  renderHeader();
  renderBody();
  state.weixinBusy = enabled ? "enable" : "disable";
  renderBody();
  try {
    await persistDraftConfig();
    await refreshWeixinStatus(false);

    const gatewayWasRunning = Boolean(state.bootstrap.status.running);
    if (gatewayWasRunning) {
      await gatewayAction("restart", false);
      await refreshWeixinStatus(false);
      if (state.bootstrap.status.running) {
        if (enabled) {
          state.lastSaveMessage = state.bootstrap.weixin?.loggedIn
            ? "微信渠道已开启，并已重启 Gateway 生效。"
            : "微信渠道已开启，但尚未登录；登录后再重启 Gateway 即可接收消息。";
        } else {
          state.lastSaveMessage = "微信渠道已关闭，并已重启 Gateway 生效。";
        }
      } else {
        state.lastSaveMessage = enabled
          ? "微信渠道已保存，但 Gateway 重启失败，请手动启动或检查日志。"
          : "微信渠道已关闭，但 Gateway 重启失败，请手动检查日志。";
      }
    } else {
      state.lastSaveMessage = enabled
        ? (state.bootstrap.weixin?.loggedIn
          ? "微信渠道已开启。启动 Gateway 后生效。"
          : "微信渠道已开启。请先扫码登录，再启动 Gateway。")
        : "微信渠道已关闭。下次启动 Gateway 时不会加载微信。";
    }
  } catch (error) {
    state.draft = previousDraft;
    ensureDesktopConfig(state.draft);
    await showAlertDialog(`微信渠道切换失败：${error.message || error}`, { title: "微信渠道切换失败" });
  } finally {
    state.weixinBusy = "";
    renderHeader();
    renderBody();
  }
}

function startWeixinLoginPolling() {
  stopWeixinLoginPolling();
  weixinLoginPollHandle = window.setTimeout(() => {
    void pollWeixinLoginOnce();
  }, 1600);
}

async function pollWeixinLoginOnce() {
  if (!state.weixinLogin?.loginId) return;
  let payload;
  try {
    payload = await fetchJson(`/api/weixin/login/status?loginId=${encodeURIComponent(state.weixinLogin.loginId)}`);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (message.includes("login_not_found")) {
      stopWeixinLoginPolling();
      state.weixinLogin = null;
      state.lastSaveMessage = "二维码会话已失效，请重新扫码登录。";
      await refreshWeixinStatus(false);
      renderHeader();
      renderBody();
      return;
    }
    state.lastSaveMessage = "正在等待微信扫码状态更新…";
    startWeixinLoginPolling();
    renderHeader();
    renderBody();
    return;
  }
  const status = payload.status || "pending";
  state.weixinLogin = { ...state.weixinLogin, ...payload, status };
  if (status === "confirmed") {
    await refreshWeixinStatus(false);
    stopWeixinLoginPolling();
    if ((state.draft.channels.weixin || {}).enabled && state.bootstrap.status.running) {
      await gatewayAction("restart", false);
      await refreshWeixinStatus(false);
      state.lastSaveMessage = state.bootstrap.status.running
        ? "微信已登录，并已重启 Gateway 生效。"
        : "微信已登录，但 Gateway 重启失败，请手动处理。";
    } else if ((state.draft.channels.weixin || {}).enabled) {
      state.lastSaveMessage = "微信已登录。启动 Gateway 后即可生效。";
    } else {
      state.lastSaveMessage = "微信已登录。启用微信渠道后再启动或重启 Gateway 即可生效。";
    }
  } else if (status === "expired") {
    state.lastSaveMessage = "二维码已过期，请重新生成。";
    stopWeixinLoginPolling();
  } else if (status === "failed") {
    state.lastSaveMessage = payload.error || "微信登录失败，请重试。";
    stopWeixinLoginPolling();
  } else if (status === "cancelled") {
    state.lastSaveMessage = "微信登录已取消。";
    stopWeixinLoginPolling();
  } else if (status === "scanned") {
    state.lastSaveMessage = "已扫码，请在手机上确认登录。";
    startWeixinLoginPolling();
  } else {
    startWeixinLoginPolling();
  }
  renderHeader();
  renderBody();
}

async function copyLogs() {
  const text = selectedLogText();
  if (!text) {
    await showAlertDialog("请先选中需要复制的日志内容。", { title: "复制日志" });
    return;
  }
  await copyText(text);
}

async function clearLogs() {
  if (!await showConfirmDialog("确定清空当前实时日志吗？这会清空 Gateway 和 Desktop 日志。", { title: "清空日志" })) return;
  await fetchJson("/api/logs/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "all" }),
  });
  state.logs = [];
  state.logLineCount = 0;
  state.logUpdatedAt = Date.now();
  state.logLastRefreshAt = Date.now();
  state.logStickBottom = true;
  state.logSelectionPaused = false;
  if (state.bootstrap?.status) state.bootstrap.status.logArchives = [];
  if (state.tab === "logs") updateLogsView(true);
  state.lastSaveMessage = "日志已清空。";
  renderHeader();
}

async function copyText(text) {
  if (!text) {
    await showAlertDialog("没有可复制的内容。");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      state.lastSaveMessage = "内容已复制到剪贴板。";
      renderHeader();
      return;
    }
  } catch {}
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    if (document.execCommand("copy")) {
      state.lastSaveMessage = "内容已复制到剪贴板。";
      renderHeader();
      return;
    }
  } catch {}
  finally {
    document.body.removeChild(textarea);
  }
  await showPromptDialog({
    title: "请手动复制以下内容",
    defaultValue: text,
    multiline: true,
    readOnly: true,
    confirmLabel: "关闭",
    hideCancel: true,
  });
}

function resolveDialog(result) {
  const resolve = dialogResolver;
  dialogResolver = null;
  state.dialog = null;
  renderOverlayLayer();
  if (typeof resolve === "function") resolve(result);
}

function showDialog(dialog) {
  if (typeof dialogResolver === "function") {
    dialogResolver({ confirmed: false, value: null });
    dialogResolver = null;
  }
  state.dialog = {
    kind: "alert",
    title: "提示",
    message: "",
    confirmLabel: "确定",
    cancelLabel: "取消",
    defaultValue: "",
    placeholder: "",
    multiline: false,
    readOnly: false,
    hideCancel: false,
    ...dialog,
  };
  renderOverlayLayer();
  return new Promise((resolve) => {
    dialogResolver = resolve;
    window.requestAnimationFrame(() => {
      const input = document.getElementById("dialogInput");
      if (input && !state.dialog?.readOnly) input.focus();
    });
  });
}

async function showAlertDialog(message, options = {}) {
  await showDialog({
    kind: "alert",
    title: options.title || "提示",
    message,
    confirmLabel: options.confirmLabel || "知道了",
    hideCancel: true,
  });
}

async function showConfirmDialog(message, options = {}) {
  const result = await showDialog({
    kind: "confirm",
    title: options.title || "请确认",
    message,
    confirmLabel: options.confirmLabel || "确认",
    cancelLabel: options.cancelLabel || "取消",
  });
  return Boolean(result?.confirmed);
}

async function showPromptDialog(options = {}) {
  const result = await showDialog({
    kind: "prompt",
    title: options.title || "请输入内容",
    message: options.message || "",
    confirmLabel: options.confirmLabel || "确认",
    cancelLabel: options.cancelLabel || "取消",
    defaultValue: options.defaultValue || "",
    placeholder: options.placeholder || "",
    multiline: Boolean(options.multiline),
    readOnly: Boolean(options.readOnly),
    hideCancel: Boolean(options.hideCancel),
  });
  if (!result?.confirmed) return null;
  return String(result.value ?? "");
}

async function submitCloseAction(action) {
  if (action === "cancel") {
    state.closePromptOpen = false;
    renderOverlayLayer();
    return;
  }
  try {
    if (action === "exit") state.closePromptBypass = true;
    state.closePromptOpen = false;
    renderOverlayLayer();
    await invokeTauri("handle_close_action", { action });
  } catch (error) {
    state.closePromptBypass = false;
    await showAlertDialog(`关闭操作失败：${error.message || error}`, { title: "关闭操作失败" });
  }
}

function openImagePreview(src, label) {
  const resolvedSrc = String(src || "").trim();
  if (!resolvedSrc) return;
  state.imagePreview = { src: resolvedSrc, label: String(label || "").trim() };
  renderOverlayLayer();
}

function closeImagePreview() {
  if (!state.imagePreview) return;
  state.imagePreview = null;
  renderOverlayLayer();
}

function renderOverlayLayer() {
  if (!els.closePromptLayer) return;
  if (state.imagePreview) {
    els.closePromptLayer.innerHTML = `
      <div class="overlay-mask image-preview-overlay" id="imagePreviewOverlay">
        <section class="image-preview-card" role="dialog" aria-modal="true" aria-labelledby="imagePreviewTitle">
          <div class="image-preview-head">
            <div>
              <p class="eyebrow">图片预览</p>
              <h3 id="imagePreviewTitle">${esc(state.imagePreview.label || "聊天图片")}</h3>
            </div>
            <button class="button button-ghost" id="closeImagePreviewBtn">关闭</button>
          </div>
          <div class="image-preview-body">
            <img class="image-preview-image" src="${escAttr(state.imagePreview.src)}" alt="${escAttr(state.imagePreview.label || "聊天图片")}">
          </div>
        </section>
      </div>
    `;
    document.getElementById("closeImagePreviewBtn")?.addEventListener("click", closeImagePreview);
    document.getElementById("imagePreviewOverlay")?.addEventListener("click", (event) => {
      if (event.target?.id === "imagePreviewOverlay") closeImagePreview();
    });
    return;
  }
  if (state.dialog) {
    const dialog = state.dialog;
    const field = dialog.kind === "prompt"
      ? (dialog.multiline
        ? `<textarea class="dialog-textarea" id="dialogInput" ${dialog.readOnly ? "readonly" : ""} placeholder="${escAttr(dialog.placeholder || "")}">${esc(dialog.defaultValue || "")}</textarea>`
        : `<input class="dialog-input" id="dialogInput" type="text" ${dialog.readOnly ? "readonly" : ""} value="${escAttr(dialog.defaultValue || "")}" placeholder="${escAttr(dialog.placeholder || "")}">`)
      : "";
    const messageHtml = dialog.message
      ? `<p class="dialog-message">${esc(dialog.message).replace(/\n/g, "<br>")}</p>`
      : "";
    els.closePromptLayer.innerHTML = `
      <div class="overlay-mask" id="dialogOverlay">
        <section class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialogTitle">
          <p class="eyebrow">桌面提示</p>
          <h3 id="dialogTitle">${esc(dialog.title || "提示")}</h3>
          ${messageHtml}
          ${field}
          <div class="dialog-actions">
            ${dialog.hideCancel ? "" : `<button class="button button-ghost" id="dialogCancelBtn">${esc(dialog.cancelLabel || "取消")}</button>`}
            <button class="button button-primary" id="dialogConfirmBtn">${esc(dialog.confirmLabel || "确定")}</button>
          </div>
        </section>
      </div>
    `;
    const getDialogValue = () => {
      const input = document.getElementById("dialogInput");
      return input ? input.value : dialog.defaultValue || "";
    };
    document.getElementById("dialogCancelBtn")?.addEventListener("click", () => resolveDialog({ confirmed: false, value: null }));
    document.getElementById("dialogConfirmBtn")?.addEventListener("click", () => resolveDialog({ confirmed: true, value: getDialogValue() }));
    document.getElementById("dialogOverlay")?.addEventListener("click", (event) => {
      if (event.target?.id === "dialogOverlay" && dialog.kind !== "prompt") {
        resolveDialog({ confirmed: false, value: null });
      }
    });
    document.getElementById("dialogInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !dialog.multiline) {
        event.preventDefault();
        resolveDialog({ confirmed: true, value: getDialogValue() });
      }
    });
    return;
  }
  if (!state.closePromptOpen) {
    els.closePromptLayer.innerHTML = "";
    return;
  }
  els.closePromptLayer.innerHTML = `
    <div class="overlay-mask">
      <section class="close-prompt-card" role="dialog" aria-modal="true" aria-labelledby="closePromptTitle">
        <p class="eyebrow">窗口关闭</p>
        <h3 id="closePromptTitle">选择“最小化”还是“关闭”</h3>
        <p class="muted">最小化会继续在托盘后台运行；关闭会直接退出桌面端。</p>
        <div class="close-prompt-actions">
          <button class="button button-primary" data-close-action="minimize">最小化</button>
          <button class="button" data-close-action="exit">关闭</button>
          <button class="button button-ghost" data-close-action="cancel">取消</button>
        </div>
      </section>
    </div>
  `;
  for (const button of els.closePromptLayer.querySelectorAll("[data-close-action]")) {
    button.onclick = () => void submitCloseAction(button.dataset.closeAction);
  }
}

function render() {
  renderShellFrame();
  renderNav();
  renderHeader();
  renderBody();
  renderOverlayLayer();
}

function renderShellFrame() {
  const chatImmersive = state.tab === "chat" && !state.isMainNavVisible;
  els.shell.classList.toggle("nav-hidden", !state.isMainNavVisible);
  els.shell.classList.toggle("chat-immersive", chatImmersive);
  els.content.dataset.tab = state.tab;
}

function renderShellLoading() {
  renderShellFrame();
  els.title.textContent = "仪表盘";
  els.gatewayDot.className = "status-dot";
  els.gatewayLabel.textContent = state.bootstrapError || "正在启动桌面后端...";
  els.versionMeta.textContent = "正在准备运行环境";
  els.nav.innerHTML = "";
  els.saveBtn.disabled = true;
  els.saveRestartBtn.disabled = true;
  els.saveState.textContent = state.bootstrapError || "等待桌面后端响应";
  els.content.innerHTML = `
    <section class="loading-panel">
      <div class="loading-orb"></div>
      <div class="loading-copy">
        <p class="eyebrow">Desktop Control Plane</p>
        <h3>正在初始化控制台</h3>
        <p class="muted">${esc(state.bootstrapError || "正在连接本地后端、Gateway 与会话索引，请稍候。")}</p>
      </div>
    </section>
  `;
}

function renderNav() {
  els.nav.innerHTML = tabs.map((tab) => `
    <button class="nav-button ${state.tab === tab.id ? "active" : ""}" data-tab="${tab.id}">
      <span class="nav-icon">${tab.short}</span>
      <span class="nav-copy">
        <strong>${tab.label}</strong>
        <em>${tab.hint}</em>
      </span>
    </button>
  `).join("");
  for (const button of els.nav.querySelectorAll("[data-tab]")) {
    button.onclick = () => setTab(button.dataset.tab);
  }
}

function setTab(tabId) {
  capturePageScroll();
  state.tab = tabId;
  state.isMainNavVisible = tabId !== "chat";
  if (tabId === "chat") {
    state.chatStickBottom = true;
    state.chatScrollTop = 0;
    render();
    void refreshChatData({ force: true });
    return;
  }
  render();
}

function setChatImmersive(enabled) {
  state.isMainNavVisible = !enabled;
  render();
}

function renderHeader() {
  if (!state.bootstrap) {
    renderShellLoading();
    return;
  }
  const current = tabs.find((item) => item.id === state.tab);
  const hiddenTitleMap = { chat: "聊天" };
  const running = Boolean(state.bootstrap.status.running);
  els.title.textContent = current?.label || hiddenTitleMap[state.tab] || "仪表盘";
  els.gatewayDot.className = `status-dot ${running ? "online" : "offline"}`;
  els.gatewayLabel.textContent = gatewayStatusSummary();
  els.versionMeta.textContent = `Desktop ${state.bootstrap.meta.desktopVersion} · Nanobot ${state.bootstrap.meta.nanobotVersion}`;
  const disableSave = state.saveBusy || state.saveRestartBusy || !isDirty();
  els.saveBtn.disabled = disableSave;
  els.saveRestartBtn.disabled = state.saveBusy || state.saveRestartBusy || (!isDirty() && !running);
  els.saveBtn.textContent = state.saveBusy ? "保存中..." : "保存配置";
  els.saveRestartBtn.textContent = state.saveRestartBusy ? "处理中..." : "保存并重启 Gateway";
  if (state.saveBusy || state.saveRestartBusy) els.saveState.textContent = "正在提交配置变更";
  else if (isDirty()) els.saveState.textContent = "存在未保存修改";
  else if (state.lastSaveMessage) els.saveState.textContent = state.lastSaveMessage;
  else if (!running && state.bootstrap.status.note) els.saveState.textContent = state.bootstrap.status.note;
  else els.saveState.textContent = running ? "Gateway 已连接" : "Gateway 当前未运行";
}

function renderBody() {
  if (!state.bootstrap || !state.draft) {
    renderShellLoading();
    return;
  }
  capturePageScroll();
  const pages = { dashboard: pageDashboard, chat: pageChat, ai: pageAi, channels: pageChannels, skills: pageSkills, logs: pageLogs };
  els.content.innerHTML = (pages[state.tab] || pageDashboard)();
  bindPage();
  restorePageScroll();
  if (state.tab === "logs") updateLogsView(true);
  else restoreLogScroll();
  restoreChatScroll();
  if (state.tab === "chat") scheduleChatMediaScrollSync();
}

function captureChatInputState() {
  const input = document.getElementById("chatInput");
  if (!input) return null;
  const active = document.activeElement === input;
  return {
    active,
    selectionStart: active ? input.selectionStart : null,
    selectionEnd: active ? input.selectionEnd : null,
    scrollTop: input.scrollTop,
  };
}

function restoreChatInputState(snapshot) {
  if (!snapshot) return;
  const input = document.getElementById("chatInput");
  if (!input) return;
  input.value = state.chatDraft || "";
  if (!snapshot.active || input.disabled) return;
  input.focus();
  if (typeof snapshot.selectionStart === "number" && typeof snapshot.selectionEnd === "number") {
    input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
  input.scrollTop = Number(snapshot.scrollTop || 0);
}

function renderChatPagePartial(options = {}) {
  if (state.tab !== "chat") {
    renderBody();
    return;
  }
  if (!state.bootstrap || !state.draft) {
    renderShellLoading();
    return;
  }
  const inputState = options.preserveInput ? captureChatInputState() : null;
  els.content.innerHTML = pageChat();
  bindPage();
  restoreChatScroll();
  scheduleChatMediaScrollSync();
  restoreChatInputState(inputState);
}

function pageDashboard() {
  const desktop = ensureDesktopConfig(state.draft);
  const channels = enabledChannels();
  const refreshSeconds = desktop.chat.refreshIntervalSeconds || 3;
  const updaterSummary = updaterSummaryText();
  const updaterDetail = updaterDetailText();
  const currentVersion = state.updater.currentVersion || state.bootstrap.meta.desktopVersion;
  return `
    <div class="dashboard-page">
      <section class="stats-grid dashboard-stats">
        ${statCard("Gateway 状态", state.bootstrap.status.running ? "运行中" : "已停止", gatewaySummaryLine())}
        ${statCard("已启用渠道", String(channels.length), channels.join(" / ") || "尚未启用任何渠道")}
        ${statCard("会话总数", String(state.sessions.length), "真实渠道会话与桌面测试会话")}
        ${statCard("Skills 数量", String(state.bootstrap.skills.items.length), "内置技能与工作区自定义技能")}
      </section>
      <section class="dashboard-middle">
        <article class="panel stack-card dashboard-card">
          <div class="section-head">
            <div><p class="eyebrow">Core Controls</p><h4>核心控制</h4></div>
            <button class="button button-ghost" id="refreshDashboardStateBtn">刷新状态</button>
          </div>
          ${state.bootstrap.status.note ? `<div class="notice warn">${esc(state.bootstrap.status.note)}</div>` : ""}
          <div class="dashboard-action-group">
            <button class="action-pill success" data-gateway="start" ${state.gatewayBusy ? "disabled" : ""}>${state.gatewayBusy === "start" ? "启动中..." : "启动"}</button>
            <button class="action-pill neutral" data-gateway="restart" ${state.gatewayBusy ? "disabled" : ""}>${state.gatewayBusy === "restart" ? "重启中..." : "重启"}</button>
            <button class="action-pill danger" data-gateway="stop" ${state.gatewayBusy ? "disabled" : ""}>${state.gatewayBusy === "stop" ? "停止中..." : "停止"}</button>
          </div>
          <div class="dashboard-shortcuts">
            <button class="button button-primary" data-switch-tab="chat">进入聊天</button>
            <button class="button" data-open-target="config">打开配置文件</button>
            <button class="button" data-open-target="workspace">打开工作区</button>
            <button class="button" data-open-target="logs">打开日志目录</button>
            <button class="button" data-open-target="skills">打开 Skills 目录</button>
          </div>
        </article>
        <article class="panel stack-card dashboard-card">
          <div class="section-head"><div><p class="eyebrow">System Settings</p><h4>系统设置</h4></div></div>
          <div class="dashboard-settings">
            <div class="dashboard-setting">
              <div class="dashboard-setting-copy">
                <strong>打开桌面后自动启动 Gateway</strong>
                <p class="muted">下次打开桌面端时生效</p>
              </div>
              <label class="switch"><input type="checkbox" data-field-path="desktop.gateway.autoStart" data-field-type="toggle" ${desktop.gateway.autoStart ? "checked" : ""}><span></span></label>
            </div>
            <div class="dashboard-setting">
              <div class="dashboard-setting-copy">
                <strong>桌面程序开机自启动</strong>
                <p class="muted">${esc(state.autoLaunchNote || "写入系统启动项")}</p>
              </div>
              <button class="button button-ghost" id="toggleAutoLaunchBtn" ${state.autoLaunchBusy || !state.autoLaunchSupported ? "disabled" : ""}>${state.autoLaunchEnabled ? "已开启" : "已关闭"}</button>
            </div>
            <div class="dashboard-setting">
              <div class="dashboard-setting-copy">
                <strong>聊天页自动刷新间隔</strong>
                <p class="muted">当前 ${refreshSeconds}s</p>
              </div>
              <div class="dashboard-setting-control">
                <input class="inline-number" type="number" min="1" max="60" step="1" value="${escAttr(String(refreshSeconds))}" data-field-path="desktop.chat.refreshIntervalSeconds" data-field-type="number">
                <span class="pill">${refreshSeconds}s</span>
              </div>
            </div>
          </div>
          <div class="dashboard-updater">
            <div>
              <p class="eyebrow">版本更新</p>
              <strong>当前版本 ${esc(currentVersion)}</strong>
              <p class="muted">${esc(updaterSummary)}</p>
              ${updaterDetail ? `<p class="muted">${esc(updaterDetail)}</p>` : ""}
            </div>
            <div class="dashboard-updater-actions">
              <button class="button button-primary" id="checkUpdatesBtn" ${(!TAURI_INVOKE || state.updaterBusy) ? "disabled" : ""}>${state.updaterBusy === "check" ? "检查中..." : "检查更新"}</button>
              ${state.updater.pending ? `<button class="button" id="installUpdateBtn" ${state.updaterBusy ? "disabled" : ""}>${state.updaterBusy === "install" ? "安装中..." : "安装更新"}</button>` : ""}
            </div>
          </div>
        </article>
      </section>
    </div>
  `;
}

function pageChatLegacy() {
  return pageChat();
}

function pageChat() {
  return pageChatLegacy();
}

function pageAiLegacy() {
  return pageAi();
}

function pageAi() {
  const providers = state.bootstrap.schema.providers || [];
  const current = providers.find((item) => item.key === state.provider) || providers[0] || { key: "", label: "" };
  const currentProviderConfig = state.draft.providers[current.key] || {};
  const agentFields = state.bootstrap.schema.agents || [];
  const webFields = state.bootstrap.schema.tools.web || [];
  const rootFields = state.bootstrap.schema.tools.root || [];
  const providerFields = current.fields || [];
  const basicProviderFields = [
    resolveField(providerFields, "apiKey", { label: "API Key", type: "password" }),
    resolveField(providerFields, "apiBase", providerApiBaseFieldMeta(current)),
  ].filter(Boolean);
  const advancedProviderFields = [
    resolveField(providerFields, "extraHeaders", { label: "额外请求头", type: "json" }),
  ].filter(Boolean);
  const requiredAgentFields = [
    mergeField(agentFields, "model", { key: "model", label: "默认模型", type: "text" }),
  ];
  const modelTuningFields = pickFields(agentFields, ["contextWindowTokens", "maxTokens", "temperature"]);
  const toolAgentFields = pickFields(agentFields, ["reasoningEffort", "maxToolIterations"]);
  const networkFields = [
    renderFields(state.draft.agents.defaults, pickFields(agentFields, ["workspace"]), "agents.defaults"),
    renderFields(state.draft.tools, pickFields(rootFields, ["restrictToWorkspace"]), "tools"),
    renderFields(state.draft.tools.web, pickFields(webFields, ["proxy", "search.maxResults"]), "tools.web"),
  ].join("");
  const developerFields = [
    renderFields(state.draft.tools.web, pickFields(webFields, ["search.provider", "search.apiKey", "search.baseUrl"]), "tools.web"),
    renderFields(state.draft.providers[current.key] || {}, advancedProviderFields, `providers.${current.key}`),
    renderFields(state.draft.agents.defaults, toolAgentFields, "agents.defaults"),
  ].join("");
  const modelValue = String(getValue(state.draft.agents.defaults, "model") || "未设置");
  return pageFrame(`
    <div class="page-stack page-scroll-stack workspace-page">
      <section class="workspace-hero ai-hero">
        <div class="ai-hero-top">
          <div class="workspace-hero-copy">
            <div class="ai-hero-heading">
              <p class="eyebrow">AI 配置</p>
              <h3>模型接入</h3>
            </div>
            <div class="workspace-chip-row ai-chip-row">
              <span class="workspace-chip strong">${esc(providerDisplayName(current.key, current.label))}</span>
              <span class="workspace-chip mono-chip" title="${escAttr(modelValue)}">${esc(shortPath(modelValue))}</span>
            </div>
          </div>
          <label class="field-card ai-provider-picker ai-provider-picker-inline">
            <span class="field-label">AI 服务商</span>
            <select data-field-path="agents.defaults.provider" data-field-type="text">
              ${providers.map((item) => `<option value="${escAttr(item.key)}" ${item.key === current.key ? "selected" : ""}>${esc(providerDisplayName(item.key, item.label))}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="field-help ai-provider-compact-help">切换服务商后，下方必填项、默认地址说明和实际生效地址会自动更新。</p>
      </section>
      <section class="page-stack ai-stack workspace-content">
        <article class="panel stack-card ai-card workspace-card">
          <div class="section-head workspace-card-head"><div><p class="eyebrow">基础必填项</p><h4>连接主配置</h4></div></div>
          <div class="form-grid ai-required-grid">
            ${renderFields(state.draft.agents.defaults, requiredAgentFields, "agents.defaults")}
            ${renderFields(currentProviderConfig, basicProviderFields, `providers.${current.key}`)}
          </div>
          ${renderProviderRuntimeBlock(current, currentProviderConfig)}
        </article>
        <section class="panel ai-advanced-shell workspace-card">
          <button type="button" class="ai-advanced-toggle ${state.aiAdvancedOpen ? "open" : ""}" id="toggleAiAdvancedBtn" aria-expanded="${state.aiAdvancedOpen ? "true" : "false"}">
            <span class="ai-advanced-toggle-copy">高级运行参数</span>
            <span class="ai-advanced-chevron" aria-hidden="true">⌄</span>
          </button>
          <div class="ai-advanced-content ${state.aiAdvancedOpen ? "open" : ""}" id="aiAdvancedContent">
            <div class="ai-advanced-content-inner">
              <div class="ai-advanced-groups">
                ${renderAiGroup("模型微调", renderFields(state.draft.agents.defaults, modelTuningFields, "agents.defaults"))}
                ${renderAiGroup("网络与环境", networkFields)}
                ${renderAiGroup("开发者配置", developerFields)}
              </div>
            </div>
          </div>
        </section>
      </section>
    </div>
  `);
}

function pickFields(fields, keys) {
  const lookup = new Map((fields || []).map((field) => [field.key, field]));
  return keys.map((key) => lookup.get(key)).filter(Boolean);
}

function renderAiGroup(title, fieldsHtml) {
  return `
    <section class="ai-group-card">
      <div class="ai-group-head">
        <h5>${esc(title)}</h5>
      </div>
      <div class="form-grid ai-group-grid">${fieldsHtml}</div>
    </section>
  `;
}

function mergeField(fields, key, fallback) {
  const found = (fields || []).find((field) => field.key === key);
  if (!found) return fallback;
  return { ...found, ...fallback };
}

function resolveField(fields, key, overrides = {}) {
  const found = (fields || []).find((field) => field.key === key);
  if (!found) return null;
  return { ...found, ...overrides };
}

function providerDefaultApiBase(provider) {
  return String(provider?.defaultApiBase || "").trim();
}

function providerConfiguredApiBase(providerConfig) {
  return String(providerConfig?.apiBase || "").trim();
}

function providerEffectiveApiBase(provider, providerConfig) {
  const configured = providerConfiguredApiBase(providerConfig);
  if (configured) return configured;
  const fallback = providerDefaultApiBase(provider);
  if (fallback) return fallback;
  if (provider?.key === "openai") return "OpenAI 官方默认地址";
  if (provider?.key === "anthropic") return "Anthropic 官方默认地址";
  return "";
}

function providerApiBaseFieldMeta(provider) {
  const defaultApiBase = providerDefaultApiBase(provider);
  if (provider?.key === "custom") {
    return {
      label: "API Base",
      type: "text",
      placeholder: "https://example.com/v1",
      help: "必须填写你自己的 OpenAI 兼容接口地址。",
    };
  }
  if (provider?.key === "ollama") {
    return {
      label: "API Base",
      type: "text",
      placeholder: defaultApiBase || "http://localhost:11434/v1",
      help: `本地 Ollama 一般使用 ${defaultApiBase || "http://localhost:11434/v1"}。`,
    };
  }
  if (provider?.key === "openai") {
    return {
      label: "API Base",
      type: "text",
      placeholder: "留空使用 OpenAI 官方默认地址",
      help: "一般留空即可；只有接代理网关或兼容中转时才需要改。",
    };
  }
  if (provider?.key === "anthropic") {
    return {
      label: "API Base",
      type: "text",
      placeholder: "留空使用 Anthropic 官方默认地址",
      help: "一般留空即可；只有接代理网关或兼容中转时才需要改。",
    };
  }
  if (defaultApiBase) {
    return {
      label: "API Base",
      type: "text",
      placeholder: defaultApiBase,
      help: `留空则使用官方默认：${defaultApiBase}`,
    };
  }
  return {
    label: "API Base",
    type: "text",
  };
}

function renderProviderRuntimeBlock(provider, providerConfig) {
  const configured = providerConfiguredApiBase(providerConfig);
  const defaultApiBase = providerDefaultApiBase(provider);
  const effective = providerEffectiveApiBase(provider, providerConfig);
  const notes = [];

  if (provider?.key === "custom") {
    notes.push("自定义兼容接口必须手动填写 API Base，桌面端不会替你推断默认地址。");
  } else if (provider?.key === "ollama") {
    notes.push(`留空时建议使用本地默认地址 ${defaultApiBase || "http://localhost:11434/v1"}。`);
  } else if (defaultApiBase) {
    notes.push(`留空时会按官方规则使用默认地址：${defaultApiBase}`);
  } else if (provider?.key === "openai" || provider?.key === "anthropic") {
    notes.push("留空时走官方 SDK 默认地址；只有代理或兼容中转时才需要手填。");
  }

  if (!notes.length && !effective) return "";

  const configuredLine = configured
    ? `<div><strong>当前配置值：</strong><span class="mono-inline">${esc(configured)}</span></div>`
    : `<div><strong>当前配置值：</strong><span>留空</span></div>`;
  const effectiveLine = effective
    ? `<div><strong>当前生效地址：</strong><span class="mono-inline">${esc(effective)}</span></div>`
    : "";

  return `
    <div class="helper-block ai-provider-runtime">
      <strong>地址说明</strong>
      ${notes.map((note) => `<p>${esc(note)}</p>`).join("")}
      <div class="ai-provider-runtime-grid">
        ${configuredLine}
        ${effectiveLine}
      </div>
    </div>
  `;
}

function pageChannels() {
  const channels = state.bootstrap.schema.channels || [];
  const enabled = channels.filter((channel) => (state.draft.channels[channel.key] || channel.defaultConfig || {}).enabled).length;
  const weixin = state.bootstrap.weixin || {};
  const weixinStatus = weixinStateText(weixin);
  return pageFrame(`
    <div class="page-stack page-scroll-stack workspace-page">
      <section class="workspace-hero">
        <div class="workspace-hero-copy">
          <p class="eyebrow">渠道配置</p>
          <h3>消息入口</h3>
          <div class="workspace-chip-row">
            <span class="workspace-chip strong">${enabled} 已启用</span>
            <span class="workspace-chip">${channels.length} 个渠道</span>
          </div>
        </div>
        <section class="workspace-hero-side workspace-hero-side-tight">
          <div class="mini-stats">
            <div class="mini-stat"><span>Telegram</span><strong>${(state.draft.channels.telegram || {}).enabled ? "开" : "关"}</strong></div>
            <div class="mini-stat"><span>微信</span><strong>${weixinStatus}</strong></div>
          </div>
        </section>
      </section>
      <section class="channel-grid channel-grid-redesign">${channels.map((channel) => renderChannelCard(channel)).join("")}</section>
    </div>
  `);
}

function pageMcp() {
  const servers = state.draft.tools.mcpServers || {};
  const names = Object.keys(servers);
  return pageFrame(`
    <div class="page-stack page-stack-fill workspace-page">
      <section class="workspace-hero">
        <div class="workspace-hero-copy">
          <p class="eyebrow">MCP</p>
          <h3>连接节点</h3>
          <div class="workspace-chip-row">
            <span class="workspace-chip strong">${names.length} 个 Server</span>
            <span class="workspace-chip">${names.length ? "已配置" : "未配置"}</span>
          </div>
        </div>
        <div class="workspace-hero-side workspace-action-side">
          <button class="button button-primary" id="addMcpBtn">新增 Server</button>
          <button class="button" data-open-target="config">打开配置文件</button>
        </div>
      </section>
      ${names.length ? `<section class="card-grid catalog-grid-redesign">${names.map((name) => renderMcpCard(name, servers[name])).join("")}</section>` : renderEmptyState("还没有 MCP Server", "新增第一个连接节点", "新增 Server", "addMcpBtn", "fill-empty-state mcp-empty-state")}
    </div>
  `);
}

function pageSkillsLegacy() {
  return pageSkills();
}

function pageLogs() {
  const sources = [
    { key: "all", label: "全部" },
    { key: "gateway", label: "Gateway" },
    { key: "desktop", label: "Desktop" },
  ];
  return `
    <div class="logs-page">
      <header class="logs-page-head">
        <div class="logs-page-meta">
          <strong>聚合日志</strong>
          <span class="muted mono-inline" id="logsMetaText">${esc(logStatusText())}</span>
        </div>
        <div class="logs-page-actions">
          <button class="button button-ghost" id="refreshLogsBtn" ${state.logRefreshBusy ? "disabled" : ""}>${state.logRefreshBusy ? "刷新中..." : "刷新"}</button>
          <button class="button button-ghost" id="clearLogsBtn">清空日志</button>
          <button class="button button-ghost" id="copyLogsBtn">复制选中</button>
        </div>
      </header>
      <div class="logs-source-strip">
        ${sources.map((item) => `<button class="button ${state.logSource === item.key ? "button-primary" : "button-ghost"}" data-log-source="${escAttr(item.key)}">${esc(item.label)}</button>`).join("")}
      </div>
      <div class="terminal-shell logs-terminal-shell">
        <pre class="terminal-window logs-terminal-window" id="gatewayLogPre" tabindex="0">${esc(logText())}</pre>
      </div>
    </div>
  `;
}

function pageChat() {
  const selected = state.selectedSession;
  const readonly = selected ? selected.readonly : true;
  const isDesktopSession = String(selected?.key || state.selectedSessionKey || "") === "desktop:console";
  const clearLabel = isDesktopSession ? "清空测试会话" : "清空会话";
  return `
    <div class="chat-page immersive">
      <aside class="chat-rail">
        <div class="chat-rail-head">
          <div class="chat-rail-title">
            <button class="button button-ghost chat-return-button" data-switch-tab="dashboard">返回主页面</button>
            <div><p class="eyebrow">会话</p><h4>会话列表</h4></div>
          </div>
          <span class="pill">${state.sessions.length}</span>
        </div>
        <div class="session-list">${renderSessionList()}</div>
      </aside>
      <section class="chat-stage">
        <header class="chat-stage-head">
          <div>
            <p class="eyebrow">聊天内容</p>
            <h3 title="${escAttr(selected?.title || "未选择会话")}">${esc(selected?.title || "未选择会话")}</h3>
            <p class="muted" title="${escAttr(selected?.subtitle || "从左侧选择会话后，在这里查看消息流。")}">${esc(selected?.subtitle || "从左侧选择会话后，在这里查看消息流。")}</p>
          </div>
          <div class="chat-stage-meta">
            <span class="channel-badge">${esc(selected?.channel || "desktop")}</span>
            <button class="button button-ghost" id="refreshChatBtn" ${state.chatManualRefreshBusy ? "disabled" : ""}>${state.chatManualRefreshBusy ? "刷新中..." : "刷新"}</button>
            ${selected ? `<button class="button button-ghost" id="clearSessionBtn" ${(state.chatBusy || state.sessionActionBusy) ? "disabled" : ""}>${state.sessionActionBusy === "clear" ? "清空中..." : clearLabel}</button>` : ""}
            ${selected && !isDesktopSession ? `<button class="button button-ghost danger" id="deleteSessionBtn" ${state.sessionActionBusy ? "disabled" : ""}>${state.sessionActionBusy === "delete" ? "删除中..." : "删除会话"}</button>` : ""}
            ${readonly ? `<span class="pill">只读</span>` : ``}
          </div>
        </header>
        <div class="chat-feed-shell"><div class="chat-feed" id="chatFeed">${renderChatFeed()}</div></div>
        <footer class="chat-compose">
          <div class="compose-box ${readonly ? "readonly" : ""}">
            <textarea id="chatInput" ${readonly ? "disabled" : ""} placeholder="${readonly ? "当前会话为只读视图" : "输入消息，Enter 发送，Shift + Enter 换行"}">${esc(state.chatDraft)}</textarea>
            <button class="button button-primary send-button" id="sendChatBtn" ${readonly || state.chatBusy ? "disabled" : ""}>${state.chatBusy ? "发送中..." : "发送"}</button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

function pageSkills() {
  const items = state.bootstrap.skills.items || [];
  const customCount = items.filter((item) => item.source === "workspace").length;
  return pageFrame(`
    <div class="page-stack page-stack-fill workspace-page">
      <section class="workspace-hero">
        <div class="workspace-hero-copy">
          <p class="eyebrow">Skills</p>
          <h3>技能库</h3>
          <div class="workspace-chip-row">
            <span class="workspace-chip strong">${items.length} 个技能</span>
            <span class="workspace-chip">${customCount} 个自定义</span>
          </div>
        </div>
        <div class="workspace-hero-side workspace-action-side">
          <button class="button" data-open-target="skills">打开 Skills 目录</button>
        </div>
      </section>
      ${items.length ? `<section class="card-grid skill-grid-scroll catalog-grid-redesign">${items.map((item) => renderSkillCard(item)).join("")}</section>` : renderEmptyState("还没有 Skill", "先打开 Skills 目录放入技能", "打开 Skills 目录", "openSkillsEmptyBtn", "fill-empty-state")}
    </div>
  `);
}

function renderChannelCard(channel) {
  const cfg = state.draft.channels[channel.key] || clone(channel.defaultConfig);
  const fields = (channel.fields || []).filter((field) => field.key !== "enabled");
  const expanded = Boolean(state.channelExpanded[channel.key]);
  const configuredCount = fields.filter((field) => {
    const value = getValue(cfg, field.key);
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && String(value).trim() !== "";
  }).length;
  if (channel.key === "weixin") return renderWeixinChannelCard(channel, cfg, fields, expanded, configuredCount);
  return `
    <article class="channel-card channel-accordion ${cfg.enabled ? "" : "disabled"} ${expanded ? "open" : ""}">
      <button class="channel-accordion-head" type="button" data-toggle-channel="${escAttr(channel.key)}" aria-expanded="${expanded ? "true" : "false"}">
        <div class="channel-card-title">
          <div class="channel-badge-large">${esc((channel.label || channel.key).slice(0, 2).toUpperCase())}</div>
          <div><p class="eyebrow">${esc(channel.key)}</p><h4>${esc(channel.label)}</h4></div>
        </div>
        <div class="channel-accordion-meta">
          <span class="channel-state">${cfg.enabled ? "已启用" : "未启用"}</span>
          <span class="workspace-chip">${configuredCount}/${fields.length}</span>
          <span class="channel-accordion-chevron" aria-hidden="true">⌄</span>
        </div>
      </button>
      ${expanded ? `
      <div class="channel-accordion-body">
        <div class="channel-toggle-row">
          <label class="field-card field-toggle">
            <span class="field-label">启用渠道</span>
            <span class="field-toggle-row"><input class="field-checkbox" type="checkbox" data-field-path="channels.${channel.key}.enabled" data-field-type="toggle" ${cfg.enabled ? "checked" : ""}><em class="field-toggle-state">${cfg.enabled ? "已开启" : "已关闭"}</em></span>
          </label>
        </div>
        <div class="form-grid channel-form-grid">${renderFields(cfg, fields, `channels.${channel.key}`)}</div>
      </div>
      ` : ""}
    </article>
  `;
}

function renderWeixinChannelCard(channel, cfg, fields, expanded, configuredCount) {
  const weixin = state.bootstrap.weixin || {};
  const sessions = state.sessions.filter((item) => item.channel === "weixin");
  const login = state.weixinLogin;
  const qrImage = login?.qrUrl ? qrImageUrl(login.qrUrl) : "";
  const channelState = weixinStateText(weixin);
  const loginState = login?.status === "scanned"
    ? "待确认"
    : (weixin.loggedIn ? "已登录" : (login?.status === "pending" ? "扫码中" : "未登录"));
  return `
    <article class="channel-card channel-accordion ${cfg.enabled ? "" : "disabled"} ${expanded ? "open" : ""}">
      <button class="channel-accordion-head" type="button" data-toggle-channel="${escAttr(channel.key)}" aria-expanded="${expanded ? "true" : "false"}">
        <div class="channel-card-title">
          <div class="channel-badge-large">WX</div>
          <div><p class="eyebrow">${esc(channel.key)}</p><h4>${esc(channel.label)}</h4></div>
        </div>
        <div class="channel-accordion-meta">
          <span class="channel-state">${channelState}</span>
          <span class="workspace-chip">${configuredCount}/${fields.length}</span>
          <span class="channel-accordion-chevron" aria-hidden="true">⌄</span>
        </div>
      </button>
      ${expanded ? `
      <div class="channel-accordion-body">
        <div class="channel-toggle-row">
          <label class="field-card field-toggle runtime-toggle-card">
            <span class="field-label">启用渠道</span>
            <span class="field-toggle-row"><input class="field-checkbox" id="weixinEnabledToggle" type="checkbox" ${cfg.enabled ? "checked" : ""} ${state.weixinBusy ? "disabled" : ""}><em class="field-toggle-state">${cfg.enabled ? "已开启" : "已关闭"}</em></span>
          </label>
        </div>
        <div class="weixin-status-grid">
          <div class="status-chip-card"><span>渠道</span><strong>${cfg.enabled ? "已开启" : "已关闭"}</strong></div>
          <div class="status-chip-card"><span>登录</span><strong>${loginState}</strong></div>
          <div class="status-chip-card"><span>Gateway</span><strong>${weixin.gatewayRunning ? "运行中" : "未运行"}</strong></div>
          <div class="status-chip-card"><span>运行态</span><strong>${esc(channelState)}</strong></div>
          <div class="status-chip-card"><span>会话</span><strong>${sessions.length}</strong></div>
          <div class="status-chip-card"><span>上下文</span><strong>${esc(String(weixin.contextCount || 0))}</strong></div>
        </div>
        <div class="weixin-action-row">
          <button class="button button-primary" id="startWeixinLoginBtn" ${state.weixinBusy ? "disabled" : ""}>${login?.status === "pending" || login?.status === "scanned" ? "刷新二维码" : "扫码登录"}</button>
          <button class="button" id="logoutWeixinBtn" ${(!weixin.loggedIn || state.weixinBusy) ? "disabled" : ""}>退出登录</button>
        </div>
        ${(login && login.qrUrl) ? `
        <section class="weixin-login-panel">
          <div class="weixin-login-copy">
            <p class="eyebrow">微信扫码</p>
            <h5>${esc(login.status === "scanned" ? "已扫码，等待手机确认" : login.status === "confirmed" ? "登录成功" : "请使用微信扫码")}</h5>
            <p class="muted">${esc(login.status === "confirmed" ? "当前账号已写入官方微信状态。" : "二维码过期后重新点一次扫码登录即可。")}</p>
            <div class="weixin-login-actions">
              <button class="button button-ghost" id="copyWeixinQrBtn">复制二维码内容</button>
            </div>
          </div>
          <div class="weixin-qr-wrap">
            <img class="weixin-qr-image" src="${escAttr(qrImage)}" alt="微信登录二维码">
          </div>
        </section>
        ` : ""}
        ${weixin.note ? `<p class="muted">${esc(weixin.note)}</p>` : ""}
        <div class="form-grid channel-form-grid">${renderFields(cfg, fields, "channels.weixin")}</div>
        <div class="weixin-meta-list">
          <div class="weixin-meta-item"><span>当前微信</span><strong title="${escAttr(weixin.account?.userId || "未登录")}">${esc(shortPath(weixin.account?.userId || "未登录"))}</strong></div>
          <div class="weixin-meta-item"><span>Bot ID</span><strong title="${escAttr(weixin.account?.botId || "未登录")}">${esc(shortPath(weixin.account?.botId || "未登录"))}</strong></div>
        </div>
      </div>
      ` : ""}
    </article>
  `;
}

function renderMcpCard(name, server) {
  const summary = server.url || server.command || "尚未填写连接信息";
  const type = server.type || "stdio";
  const toolCount = Array.isArray(server.enabledTools) ? server.enabledTools.length : (Array.isArray(server.enabled_tools) ? server.enabled_tools.length : 0);
  return `
    <article class="catalog-card catalog-card-redesign">
      <div class="catalog-head">
        <div class="catalog-title-block">
          <div class="catalog-icon">MC</div>
          <div><strong title="${escAttr(name)}">${esc(name)}</strong><small>${esc(type)}</small></div>
        </div>
        <span class="status-tag">${esc(type)}</span>
      </div>
      <p class="catalog-desc" title="${escAttr(summary)}">${esc(summary)}</p>
      <div class="catalog-meta mono-inline" title="${escAttr(summary)}">${esc(summary)}</div>
      <div class="catalog-foot"><span class="catalog-count mono-inline">tools ${toolCount || "*"}</span><button class="button button-ghost" data-remove-mcp="${escAttr(name)}">移除</button></div>
    </article>
  `;
}

function renderSkillCard(item) {
  const sourceLabel = item.source === "workspace" ? "自定义" : "内置";
  const triggerLabel = item.always ? "始终加载" : "按需触发";
  const description = skillDescription(item);
  return `
    <article class="catalog-card catalog-card-redesign skill-card-redesign">
      <div class="catalog-head">
        <div class="catalog-title-block">
          <div class="catalog-icon">${esc(item.name.slice(0, 2).toUpperCase())}</div>
          <div><strong title="${escAttr(item.name)}">${esc(item.name)}</strong><small>${esc(sourceLabel)}</small></div>
        </div>
        <span class="status-tag ${item.source === "workspace" ? "running" : ""}">${esc(sourceLabel)}</span>
      </div>
      <p class="catalog-desc" title="${escAttr(description)}">${esc(description)}</p>
      <div class="catalog-meta mono-inline" title="${escAttr(item.path)}">${esc(item.path)}</div>
      <div class="catalog-foot">${item.editable ? `<button class="button button-ghost" data-delete-skill="${escAttr(item.name)}">删除</button>` : `<span></span>`}<span class="catalog-count mono-inline">触发方式 ${esc(triggerLabel)}</span></div>
    </article>
  `;
}

function renderEmptyState(title, body, buttonLabel, buttonId, extraClass = "") {
  return `
    <section class="empty-state ${extraClass}">
      <div class="empty-illustration">NB</div>
      <h4>${esc(title)}</h4>
      <p>${esc(body)}</p>
      <button class="button button-primary" id="${buttonId}">${esc(buttonLabel)}</button>
    </section>
  `;
}

function pageFrame(inner) {
  return `<div class="page-frame"><div class="page-scroll">${inner}</div></div>`;
}

function statCard(label, value, note) {
  return `<article class="stat-card"><p class="eyebrow">${esc(label)}</p><strong>${esc(value)}</strong><p class="muted">${esc(note)}</p></article>`;
}

function settingRow(label, value, hint, trailing = "") {
  return `<div class="setting-row"><div class="setting-copy"><strong>${esc(label)}</strong><p class="muted">${esc(hint)}</p></div><div class="setting-trailing"><span class="pill">${esc(value)}</span>${trailing}</div></div>`;
}

function resourceRow(label, path) {
  return `<div class="resource-row"><span class="resource-label">${esc(label)}</span><span class="resource-path mono-inline" title="${escAttr(path)}">${esc(path)}</span></div>`;
}

function setActiveSession(sessionKey) {
  if (!sessionKey || sessionKey === state.selectedSessionKey) return;
  state.selectedSessionKey = sessionKey;
  state.selectedSession = state.sessions.find((item) => item.key === sessionKey) || null;
  state.selectedSessionItems = [];
  state.chatStickBottom = true;
  state.chatScrollTop = 0;
  renderBody();
  void (async () => {
    await refreshSelectedSession();
    renderBody();
  })();
}

function toggleChannelExpanded(channelKey) {
  state.channelExpanded[channelKey] = !state.channelExpanded[channelKey];
  renderBody();
}

function gatewaySummaryLine() {
  const status = state.bootstrap.status;
  if (status.running) return `PID ${status.pid}`;
  if (status.note) return status.note;
  return "等待启动或手动唤起";
}

function gatewayStatusSummary() {
  const status = state.bootstrap?.status;
  if (!status) return "Gateway 未运行";
  if (status.running) return `Gateway 运行中 · PID ${status.pid}`;
  if (status.note) return `Gateway 未启动 · ${status.note}`;
  return "Gateway 未运行";
}

function renderSessionList() {
  if (!state.sessions.length) return `<div class="session-empty">还没有可显示的会话。</div>`;
  return state.sessions.map((item) => `
    <button class="session-card ${item.key === state.selectedSessionKey ? "active" : ""}" data-session-key="${escAttr(item.key)}" title="${escAttr(`${item.title}\n${item.subtitle || "暂无摘要"}`)}">
      <span class="session-accent"></span>
      <div class="session-badge">${esc((item.channel || "lo").slice(0, 2).toUpperCase())}</div>
      <div class="session-copy"><strong title="${escAttr(item.title)}">${esc(item.title)}</strong><p title="${escAttr(item.subtitle || "暂无摘要")}">${esc(item.subtitle || "暂无摘要")}</p><small>${esc(formatUpdatedAt(item.updatedAt))}</small></div>
    </button>
  `).join("");
}

function renderChatFeed() {
  const items = visibleChatItems();
  if (!items.length) {
    return `<div class="chat-empty"><div class="empty-illustration small">...</div><h4>当前会话还没有消息</h4><p>从左侧选择一个会话，或使用桌面测试会话发送消息。</p></div>`;
  }
  return items.map((item) => {
    const userSide = item.role === "user";
    return `
      <article class="bubble-row ${userSide ? "user" : "assistant"}">
        <div class="bubble-meta"><span>${esc(roleLabel(item.role, item.name))}</span><span>${esc(shortTimestamp(item.timestamp))}</span></div>
        <div class="bubble">${renderBubbleContent(item)}</div>
      </article>
    `;
  }).join("");
}

function renderFields(source, fields, basePath) {
  return (fields || []).map((field) => renderField(source, field, basePath)).join("");
}

function renderFieldLegacy(source, field, basePath) {
  const path = `${basePath}.${field.key}`;
  const value = getValue(source, field.key);
  const label = field.label || field.key;
  const help = field.help ? `<div class="field-help">${esc(field.help)}</div>` : "";
  if (field.type === "toggle") {
    return `<label class="field-card field-toggle"><span class="field-label">${esc(label)}</span><span class="field-toggle-row"><input type="checkbox" data-field-path="${escAttr(path)}" data-field-type="toggle" ${value ? "checked" : ""}><em>${value ? "已开启" : "已关闭"}</em></span>${help}</label>`;
  }
  if (field.type === "select" || field.type === "select-provider") {
    const options = field.type === "select-provider" ? (state.bootstrap.schema.providers || []).map((item) => ({ label: item.label, value: item.key })) : (field.options || []);
    return `<label class="field-card"><span class="field-label">${esc(label)}</span><select data-field-path="${escAttr(path)}" data-field-type="text">${options.map((option) => `<option value="${escAttr(String(option.value))}" ${String(option.value) === String(value ?? "") ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>${help}</label>`;
  }
  if (field.type === "textarea" || field.type === "list" || field.type === "json") {
    const parser = field.type === "list" ? "list" : (field.type === "json" ? "json" : "");
    const textareaValue = field.type === "list" ? (Array.isArray(value) ? value.join("\n") : "") : field.type === "json" ? asJson(value) : String(value ?? "");
    return `<label class="field-card"><span class="field-label">${esc(label)}</span><textarea data-field-path="${escAttr(path)}" data-field-type="text" ${parser ? `data-parser="${parser}"` : ""} placeholder="${escAttr(field.placeholder || "")}">${esc(textareaValue)}</textarea>${help}</label>`;
  }
  const inputType = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
  return `<label class="field-card"><span class="field-label">${esc(label)}</span><input type="${inputType}" data-field-path="${escAttr(path)}" data-field-type="${field.type === "number" ? "number" : "text"}" value="${escAttr(value == null ? "" : String(value))}" placeholder="${escAttr(field.placeholder || "")}" ${field.step != null ? `step="${escAttr(String(field.step))}"` : ""}>${help}</label>`;
}

function renderField(source, field, basePath) {
  const path = `${basePath}.${field.key}`;
  const value = getValue(source, field.key);
  const label = field.label || field.key;
  const help = field.help ? `<div class="field-help">${esc(field.help)}</div>` : "";
  if (field.type === "toggle") {
    return `<label class="field-card field-toggle"><span class="field-label">${esc(label)}</span><span class="field-toggle-row"><input class="field-checkbox" type="checkbox" data-field-path="${escAttr(path)}" data-field-type="toggle" ${value ? "checked" : ""}><em class="field-toggle-state">${value ? "已开启" : "已关闭"}</em></span>${help}</label>`;
  }
  if (field.type === "select" || field.type === "select-provider") {
    const options = field.type === "select-provider"
      ? (state.bootstrap.schema.providers || []).map((item) => ({ label: providerDisplayName(item.key, item.label), value: item.key }))
      : (field.options || []);
    return `<label class="field-card"><span class="field-label">${esc(label)}</span><select data-field-path="${escAttr(path)}" data-field-type="text">${options.map((option) => `<option value="${escAttr(String(option.value))}" ${String(option.value) === String(value ?? "") ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>${help}</label>`;
  }
  if (field.type === "textarea" || field.type === "list" || field.type === "json") {
    const parser = field.type === "list" ? "list" : (field.type === "json" ? "json" : "");
    const textareaValue = field.type === "list" ? (Array.isArray(value) ? value.join("\n") : "") : field.type === "json" ? asJson(value) : String(value ?? "");
    return `<label class="field-card"><span class="field-label">${esc(label)}</span><textarea data-field-path="${escAttr(path)}" data-field-type="text" ${parser ? `data-parser="${parser}"` : ""} placeholder="${escAttr(field.placeholder || "")}">${esc(textareaValue)}</textarea>${help}</label>`;
  }
  const inputType = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
  return `<label class="field-card"><span class="field-label">${esc(label)}</span><input type="${inputType}" data-field-path="${escAttr(path)}" data-field-type="${field.type === "number" ? "number" : "text"}" value="${escAttr(value == null ? "" : String(value))}" placeholder="${escAttr(field.placeholder || "")}" ${field.step != null ? `step="${escAttr(String(field.step))}"` : ""}>${help}</label>`;
}

function bindPage() {
  for (const button of document.querySelectorAll("[data-switch-tab]")) button.onclick = () => setTab(button.dataset.switchTab);
  for (const button of document.querySelectorAll("[data-toggle-channel]")) button.onclick = () => toggleChannelExpanded(button.dataset.toggleChannel);
  for (const button of document.querySelectorAll("[data-provider]")) button.onclick = () => { state.provider = button.dataset.provider; applyValue("agents.defaults.provider", state.provider); render(); };
  for (const button of document.querySelectorAll("[data-session-key]")) button.onclick = () => setActiveSession(button.dataset.sessionKey);
  for (const button of document.querySelectorAll("[data-open-target]")) button.onclick = () => openTarget(button.dataset.openTarget);
  for (const button of document.querySelectorAll("[data-gateway]")) button.onclick = () => gatewayAction(button.dataset.gateway);
  for (const button of document.querySelectorAll("[data-delete-skill]")) button.onclick = () => deleteSkill(button.dataset.deleteSkill);
  for (const button of document.querySelectorAll("[data-remove-mcp]")) button.onclick = () => { delete (state.draft.tools.mcpServers || {})[button.dataset.removeMcp]; state.restartRecommended = true; render(); };

  document.getElementById("refreshChatBtn")?.addEventListener("click", async () => { await refreshChatData({ force: true, manual: true }); });
  document.getElementById("sendChatBtn")?.addEventListener("click", sendChatMessage);
  document.getElementById("clearChatBtn")?.addEventListener("click", clearChatHistory);
  document.getElementById("clearSessionBtn")?.addEventListener("click", clearSelectedSession);
  document.getElementById("deleteSessionBtn")?.addEventListener("click", deleteSelectedSession);
  document.getElementById("createSkillBtn")?.addEventListener("click", createSkill);
  document.getElementById("openSkillsEmptyBtn")?.addEventListener("click", () => openTarget("skills"));
  document.getElementById("addMcpBtn")?.addEventListener("click", async () => {
    const name = await showPromptDialog({
      title: "新增 MCP Server",
      message: "请输入 MCP Server 名称",
      placeholder: "my-server",
    });
    if (!name) return;
    state.draft.tools.mcpServers ||= {};
    if (!state.draft.tools.mcpServers[name]) state.draft.tools.mcpServers[name] = clone(state.bootstrap.schema.mcpServerTemplate);
    state.restartRecommended = true;
    render();
  });

  document.getElementById("toggleAutoLaunchBtn")?.addEventListener("click", () => setAutoLaunch(!state.autoLaunchEnabled));
  document.getElementById("toggleOverviewAutoLaunchBtn")?.addEventListener("click", () => setAutoLaunch(!state.autoLaunchEnabled));
  document.getElementById("refreshDesktopStateBtn")?.addEventListener("click", async () => { await refreshUpdaterState(false); await refreshAutoLaunchState(false); renderBody(); });
  document.getElementById("refreshDashboardStateBtn")?.addEventListener("click", async () => { await refreshUpdaterState(false); await refreshAutoLaunchState(false); await refreshRuntime(); renderBody(); });
  document.getElementById("refreshOverviewDesktopStateBtn")?.addEventListener("click", async () => { await refreshUpdaterState(false); await refreshAutoLaunchState(false); renderBody(); });
  document.getElementById("checkUpdatesBtn")?.addEventListener("click", checkUpdates);
  document.getElementById("installUpdateBtn")?.addEventListener("click", installUpdate);
  document.getElementById("refreshLogsBtn")?.addEventListener("click", refreshLogsView);
  document.getElementById("clearLogsBtn")?.addEventListener("click", clearLogs);
  document.getElementById("copyLogsBtn")?.addEventListener("click", copyLogs);
  for (const button of document.querySelectorAll("[data-log-source]")) {
    button.addEventListener("click", () => {
      state.logSource = button.dataset.logSource || "all";
      state.logStickBottom = true;
      state.logSelectionPaused = false;
      void refreshLogsView();
    });
  }
  document.getElementById("toggleAiAdvancedBtn")?.addEventListener("click", toggleAiAdvancedPanel);
  document.getElementById("startWeixinLoginBtn")?.addEventListener("click", () => weixinAction("startLogin"));
  document.getElementById("logoutWeixinBtn")?.addEventListener("click", () => weixinAction("logout"));
  document.getElementById("copyWeixinQrBtn")?.addEventListener("click", () => copyText(state.weixinLogin?.qrUrl || ""));
  document.getElementById("weixinEnabledToggle")?.addEventListener("change", (event) => {
    void syncWeixinEnabled(event.target.checked);
  });

  const chatInput = document.getElementById("chatInput");
  if (chatInput) {
    chatInput.addEventListener("input", () => { state.chatDraft = chatInput.value; });
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
      }
    });
  }

  document.getElementById("gatewayLogPre")?.addEventListener("scroll", captureLogScroll);
  document.getElementById("chatFeed")?.addEventListener("scroll", captureChatScroll);
  for (const image of document.querySelectorAll(".chat-inline-media-image")) {
    image.addEventListener("click", () => openImagePreview(image.dataset.previewSrc, image.dataset.previewLabel));
    const syncScroll = () => scheduleChatMediaScrollSync();
    if (image.complete) syncScroll();
    else {
      image.addEventListener("load", syncScroll, { once: true });
      image.addEventListener("error", syncScroll, { once: true });
    }
  }

  for (const input of document.querySelectorAll("[data-field-path]")) {
    const commitValue = () => {
      let value;
      const type = input.dataset.fieldType || "text";
      const parser = input.dataset.parser || "";
      if (type === "toggle") value = input.checked;
      else if (type === "number") value = input.value === "" ? 0 : Number(input.value);
      else value = input.value;
      if (parser === "list") value = String(value).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      if (parser === "json") {
        try {
          value = String(value).trim() ? JSON.parse(String(value)) : {};
        } catch (error) {
          void showAlertDialog(`JSON 格式错误：${error.message}`, { title: "JSON 格式错误" });
          return;
        }
      }
      applyValue(input.dataset.fieldPath, value);
      if (state.tab === "ai" && input.dataset.fieldPath === "agents.defaults.provider") state.provider = value;
      if (state.tab === "ai" && input.dataset.fieldPath === "agents.defaults.provider") {
        render();
        return;
      }
      if (String(input.dataset.fieldPath || "").startsWith("channels.") || String(input.dataset.fieldPath || "").startsWith("desktop.")) renderBody();
      renderHeader();
    };
    input.addEventListener("change", commitValue);
    if (input.tagName !== "TEXTAREA" || !input.dataset.parser) input.addEventListener("input", commitValue);
  }
}

function toggleAiAdvancedPanel(force) {
  state.aiAdvancedOpen = typeof force === "boolean" ? force : !state.aiAdvancedOpen;
  const button = document.getElementById("toggleAiAdvancedBtn");
  const content = document.getElementById("aiAdvancedContent");
  button?.classList.toggle("open", state.aiAdvancedOpen);
  button?.setAttribute("aria-expanded", state.aiAdvancedOpen ? "true" : "false");
  content?.classList.toggle("open", state.aiAdvancedOpen);
}

function captureLogScroll() {
  const node = document.getElementById("gatewayLogPre");
  if (!node) return;
  state.logScrollTop = node.scrollTop;
  state.logStickBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 20;
  updateLogsMeta();
}

function getPageScrollNode() {
  return els.content.querySelector(".page-scroll");
}

function capturePageScroll() {
  const node = getPageScrollNode();
  if (!node) return;
  const key = els.content.dataset.tab || state.tab;
  state.pageScrollTops[key] = node.scrollTop;
}

function restorePageScroll() {
  const node = getPageScrollNode();
  if (!node) return;
  const key = state.tab;
  node.scrollTop = state.pageScrollTops[key] || 0;
}

function restoreLogScroll() {
  const node = document.getElementById("gatewayLogPre");
  if (!node) return;
  if (state.logStickBottom) node.scrollTop = node.scrollHeight;
  else node.scrollTop = state.logScrollTop;
}

function captureChatScroll() {
  const node = document.getElementById("chatFeed");
  if (!node) return;
  state.chatScrollTop = node.scrollTop;
  state.chatStickBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 20;
}

function restoreChatScroll() {
  const node = document.getElementById("chatFeed");
  if (!node) return;
  if (state.chatStickBottom) node.scrollTop = node.scrollHeight;
  else node.scrollTop = state.chatScrollTop;
}

function scheduleChatMediaScrollSync() {
  if (state.tab !== "chat" || !state.chatStickBottom) return;
  const sync = () => restoreChatScroll();
  window.requestAnimationFrame(() => {
    sync();
    window.requestAnimationFrame(sync);
  });
  window.setTimeout(sync, 80);
}

function currentRefreshIntervalMs() {
  if (!state.draft) return 3000;
  const seconds = Number(ensureDesktopConfig(state.draft).chat.refreshIntervalSeconds || 3);
  return Math.max(1, seconds) * 1000;
}

function ensureDesktopConfig(target) {
  target.desktop ||= {};
  target.desktop.gateway ||= {};
  target.desktop.app ||= {};
  target.desktop.chat ||= {};
  if (target.desktop.gateway.autoStart == null) target.desktop.gateway.autoStart = true;
  if (target.desktop.app.autoLaunch == null) target.desktop.app.autoLaunch = false;
  if (target.desktop.chat.refreshIntervalSeconds == null) target.desktop.chat.refreshIntervalSeconds = 3;
  return target.desktop;
}

function enabledChannels() {
  const channels = state.draft?.channels || {};
  return Object.entries(channels).filter(([, value]) => typeof value === "object" && value && value.enabled).map(([key]) => key);
}

function roleLabel(role, name) {
  if (name) return `${role || "assistant"} · ${name}`;
  if (role === "user") return "User";
  if (role === "assistant") return "Nanobot";
  if (role === "system") return "System";
  return role || "assistant";
}

function visibleChatItems() {
  const items = Array.isArray(state.selectedSessionItems) ? state.selectedSessionItems : [];
  return projectExternalChatItems(items);
}

function isDesktopConsoleSession() {
  return String(state.selectedSessionKey || "") === "desktop:console";
}

function projectExternalChatItems(items) {
  const visible = [];
  let currentUser = null;
  let outboundAssistants = [];
  let fallbackAssistants = [];

  const flushTurn = () => {
    if (currentUser && hasRenderableBubble(currentUser)) visible.push(currentUser);
    const assistants = outboundAssistants.length ? outboundAssistants : fallbackAssistants;
    for (const item of assistants) {
      if (shouldRenderExternalChatItem(item)) visible.push(item);
    }
    currentUser = null;
    outboundAssistants = [];
    fallbackAssistants = [];
  };

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.role === "user") {
      flushTurn();
      currentUser = item;
      continue;
    }
    if (!currentUser) continue;
    const toolOutboundItems = extractMessageToolCallItems(item);
    if (toolOutboundItems.length) {
      outboundAssistants.push(...toolOutboundItems);
      fallbackAssistants = [];
      continue;
    }
    if (isExplicitOutboundItem(item)) {
      outboundAssistants.push(item);
      continue;
    }
    if (item.role === "tool") {
      fallbackAssistants = [];
      continue;
    }
    if (item.role !== "assistant") continue;
    if (Array.isArray(item.toolCalls) && item.toolCalls.length) {
      fallbackAssistants = [];
      continue;
    }
    if (hasRenderableMessageContent(item)) fallbackAssistants.push(item);
  }

  flushTurn();
  return visible;
}

function shouldRenderExternalChatItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.role === "user") return hasRenderableBubble(item);
  if (item.role !== "assistant") return false;
  if (Array.isArray(item.toolCalls) && item.toolCalls.length) return false;
  return hasRenderableBubble(item);
}

function isExplicitOutboundItem(item) {
  return Boolean(item?.metadata && item.metadata._desktop_visible_outbound);
}

function extractMessageToolCallItems(item) {
  if (!item || item.role !== "assistant" || !Array.isArray(item.toolCalls) || !item.toolCalls.length) return [];
  const sessionChannel = String(state.selectedSession?.channel || state.selectedSessionKey.split(":")[0] || "");
  const sessionChatId = String(state.selectedSession?.chatId || state.selectedSessionKey.split(":").slice(1).join(":") || "");
  const results = [];
  for (const toolCall of item.toolCalls) {
    const fn = toolCall?.function;
    if (!fn || fn.name !== "message" || typeof fn.arguments !== "string") continue;
    let args;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      continue;
    }
    if (!args || typeof args !== "object") continue;
    if (String(args.channel || "") !== sessionChannel) continue;
    if (String(args.chat_id || "") !== sessionChatId) continue;
    const mediaPaths = Array.isArray(args.media) ? args.media.map((media) => normalizeMediaValue(media)).filter(Boolean) : [];
    const imageMedia = mediaPaths.filter((media) => isImageMediaValue(media));
    const mediaLines = mediaPaths.filter((media) => !isImageMediaValue(media)).map((media) => formatOutboundMediaLine(media)).filter(Boolean);
    const text = typeof args.content === "string" ? args.content.trim() : "";
    if (text || mediaLines.length) {
      results.push(buildSyntheticOutboundItem(item, text, imageMedia, mediaLines));
      continue;
    }
    if (imageMedia.length) {
      results.push(buildSyntheticOutboundItem(item, text, imageMedia, mediaLines));
      continue;
    }
    if (!text && !mediaLines.length) {
      results.push(buildSyntheticOutboundItem(item, "[已发送消息]", [], []));
    }
  }
  return results;
}

function buildSyntheticOutboundItem(sourceItem, text, media = [], extraLines = []) {
  const lines = [];
  if (typeof text === "string" && text.trim()) lines.push(text.trim());
  return {
    role: "assistant",
    name: sourceItem?.name || "",
    timestamp: sourceItem?.timestamp || "",
    content: lines.join("\n\n").trim(),
    media: Array.isArray(media) ? media : [],
    attachments: Array.isArray(extraLines) ? extraLines.filter((line) => typeof line === "string" && line.trim()).map((line) => line.trim()) : [],
    metadata: { _desktop_projected_outbound: true },
  };
}

function formatOutboundMediaLine(media) {
  const raw = normalizeMediaValue(media);
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const name = normalized.split("/").pop() || raw;
  const lower = name.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|bmp)$/.test(lower)) return `[图片] ${name}`;
  if (/\.(mp4|mov|m4v|webm)$/.test(lower)) return `[视频] ${name}`;
  if (/\.(mp3|wav|ogg|aac|m4a|silk)$/.test(lower)) return `[音频] ${name}`;
  return `[文件] ${name}`;
}

function hasRenderableMessageContent(item) {
  const content = item?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.some((part) => {
    if (typeof part === "string") return part.trim().length > 0;
    if (!part || typeof part !== "object") return false;
    if (typeof part.text === "string" && part.text.trim()) return true;
    if (typeof part.content === "string" && part.content.trim()) return true;
    return false;
  });
  return false;
}

function hasRenderableBubble(item) {
  const parts = getBubbleDisplayParts(item);
  return Boolean(parts.text || parts.images.length || parts.attachments.length);
}

function normalizeMediaValue(value) {
  return String(value || "").trim().replace(/^['"]+|['"]+$/g, "");
}

function isRemoteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isImageMediaValue(value) {
  const raw = normalizeMediaValue(value);
  if (!raw) return false;
  return /\.(png|jpg|jpeg|gif|webp|bmp)(?:$|[?#])/i.test(raw);
}

function mediaPreviewSrc(value) {
  const raw = normalizeMediaValue(value);
  if (!raw) return "";
  if (isRemoteHttpUrl(raw)) return raw;
  return `${API_BASE}/api/media?path=${encodeURIComponent(raw)}`;
}

function getBubbleDisplayParts(item) {
  const imageSet = new Set();
  const images = [];
  const attachments = [];

  const pushImage = (value) => {
    const raw = normalizeMediaValue(value);
    if (!raw || !isImageMediaValue(raw) || imageSet.has(raw)) return;
    imageSet.add(raw);
    images.push(raw);
  };

  const pushAttachment = (value) => {
    const raw = normalizeMediaValue(value);
    if (!raw) return;
    if (isImageMediaValue(raw)) {
      pushImage(raw);
      return;
    }
    const line = formatOutboundMediaLine(raw);
    if (line) attachments.push(line);
  };

  let text = typeof item?.content === "string" ? item.content : "";
  text = text.replace(/\[Image:\s*source:\s*([^\]\r\n]+)\]/gi, (_, path) => {
    pushImage(path);
    return "";
  });
  text = text.replace(/\[image:\s*([^\]\r\n]+)\]/gi, (_, path) => {
    pushImage(path);
    return "";
  });
  text = text.replace(/^\[image\]\s*$/gim, "");

  for (const media of Array.isArray(item?.media) ? item.media : []) pushAttachment(media);
  for (const line of Array.isArray(item?.attachments) ? item.attachments : []) {
    if (typeof line === "string" && line.trim()) attachments.push(line.trim());
  }

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text, images, attachments };
}

function renderBubbleContent(item) {
  const parts = getBubbleDisplayParts(item);
  const sections = [];
  if (parts.text) sections.push(`<div class="bubble-text">${renderMessageContent(parts.text)}</div>`);
  if (parts.images.length) {
    sections.push(`
      <div class="bubble-media-strip">
        ${parts.images.map((path) => {
          const name = path.replace(/\\/g, "/").split("/").pop() || path;
          const previewSrc = mediaPreviewSrc(path);
          return `<figure class="chat-inline-media"><img class="chat-inline-media-image" src="${escAttr(previewSrc)}" data-preview-src="${escAttr(previewSrc)}" data-preview-label="${escAttr(name)}" alt="${escAttr(name)}" loading="lazy"><figcaption>${esc(name)}</figcaption></figure>`;
        }).join("")}
      </div>
    `);
  }
  if (parts.attachments.length) {
    sections.push(`<div class="bubble-attachment-list">${parts.attachments.map((line) => `<div class="bubble-attachment-item">${esc(line)}</div>`).join("")}</div>`);
  }
  return sections.join("");
}

function formatUpdatedAt(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function shortTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function shortPath(value) {
  const text = String(value || "");
  return text.length > 64 ? `...${text.slice(-61)}` : text;
}

function defaultSessionKey(items) {
  const list = Array.isArray(items) ? items : [];
  return list.find((item) => item.key !== "desktop:console")?.key || list[0]?.key || "desktop:console";
}

function providerQuickHintLegacy(key) {
  const hints = {
    custom: "Custom 兼容接口通常需要同时填写 API Base 与 API Key。",
    openrouter: "OpenRouter 常见组合是 provider 选 openrouter，模型填写完整上游模型名。",
    ollama: "Ollama 本地模型通常只需要 API Base，例如 http://localhost:11434。",
    dashscope: "DashScope / Qwen 通常需要 API Key，必要时补充 API Base。",
  };
  return hints[key] || "优先保证 Provider、模型名与 Key 三项对应正确。";
}

function providerQuickHint(key) {
  const hints = {
    custom: "自定义兼容接口通常需要同时填写 API Base、API Key，额外请求头放到高级参数里。",
    openrouter: "OpenRouter 常见组合是供应商选 OpenRouter，模型填写完整的上游模型名。",
    ollama: "Ollama 本地模型通常只需要 API Base，例如 http://localhost:11434。",
    dashscope: "通义千问通常需要 API Key；如果你走企业网关，再补充 API Base。",
  };
  return hints[key] || "优先保证供应商、默认模型和 API Key 这三项对应正确。";
}

function providerDisplayName(key, fallback) {
  const names = {
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    openai: "OpenAI",
    deepseek: "DeepSeek",
    dashscope: "通义千问",
    gemini: "Gemini",
    moonshot: "Kimi",
    zhipu: "智谱 GLM",
    ollama: "Ollama",
    custom: "自定义兼容接口",
  };
  return names[key] || fallback || key;
}

function logText() {
  return state.logs.length ? state.logs.join("\n") : "暂无日志输出。";
}

function logStatusText() {
  const updated = state.logUpdatedAt ? shortTimestamp(state.logUpdatedAt) : "--:--";
  const refreshed = state.logLastRefreshAt ? shortTimestamp(state.logLastRefreshAt) : "--:--";
  const follow = state.logStickBottom ? "自动跟随" : "暂停跟随";
  const paused = state.logSelectionPaused ? " · 选中文本时暂停更新" : "";
  const source = {
    all: "全部",
    gateway: "Gateway",
    desktop: "Desktop",
  }[state.logSource || "all"] || (state.logSource || "all");
  return `${source} · ${follow} · ${state.logLineCount} 行 · 文件更新 ${updated} · 刷新 ${refreshed}${paused}`;
}

function updateLogsMeta() {
  const node = document.getElementById("logsMetaText");
  if (node) node.textContent = logStatusText();
}

function selectedLogText() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  const logNode = document.getElementById("gatewayLogPre");
  if (!logNode) return "";
  const range = selection.getRangeAt(0);
  if (!logNode.contains(range.commonAncestorContainer)) return "";
  return selection.toString();
}

function isLogSelectionActive() {
  return Boolean(selectedLogText());
}

function updateLogsView(force = false) {
  const node = document.getElementById("gatewayLogPre");
  if (!node) return;
  const previousScrollTop = node.scrollTop;
  const wasAtBottom = state.logStickBottom || previousScrollTop + node.clientHeight >= node.scrollHeight - 20;
  if (!force && isLogSelectionActive()) {
    state.logSelectionPaused = true;
    updateLogsMeta();
    return;
  }
  state.logSelectionPaused = false;
  const nextText = logText();
  if (node.textContent !== nextText) node.textContent = nextText;
  if (wasAtBottom) node.scrollTop = node.scrollHeight;
  else node.scrollTop = previousScrollTop;
  captureLogScroll();
}

async function refreshLogsView() {
  if (state.logRefreshBusy) return;
  state.logRefreshBusy = true;
  renderBody();
  try {
    captureLogScroll();
    await refreshLogs();
    if (state.tab === "logs") updateLogsView(true);
    state.lastSaveMessage = `日志已刷新 ${shortTimestamp(Date.now())}`;
    renderHeader();
  } catch (error) {
    state.lastSaveMessage = `日志刷新失败：${error.message || error}`;
    renderHeader();
  } finally {
    state.logRefreshBusy = false;
    if (state.tab === "logs") renderBody();
  }
}

function isDirty() {
  if (!state.bootstrap || !state.draft) return false;
  return JSON.stringify(state.draft) !== JSON.stringify(state.bootstrap.config);
}

function getValue(source, keyPath) {
  return keyPath.split(".").reduce((current, segment) => (current == null ? undefined : current[segment]), source);
}

function applyValue(path, value) {
  const parts = path.split(".");
  let cursor = state.draft;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (cursor[part] == null || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function renderMessageContent(text) {
  const tokens = [];
  const pushToken = (html) => {
    const token = `__HTML_TOKEN_${tokens.length}__`;
    tokens.push(html);
    return token;
  };
  let html = esc(String(text || ""));
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, url) => pushToken(imageHtml(url, alt || "图片")));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => pushToken(linkHtml(url, label)));
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/gim, (_, prefix, url) => `${prefix}${pushToken(linkHtml(url, url))}`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\n/g, "<br>");
  return tokens.reduce((output, tokenHtml, index) => output.replaceAll(`__HTML_TOKEN_${index}__`, tokenHtml), html);
}

function imageHtml(url, alt) {
  return `<figure class="inline-image"><img src="${escAttr(url)}" alt="${escAttr(alt)}" loading="lazy"><figcaption>${esc(alt)}</figcaption></figure>`;
}

function linkHtml(url, label) {
  return `<a class="message-link" href="${escAttr(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>`;
}

function asJson(value) {
  if (value == null || value === "") return "";
  try { return JSON.stringify(value, null, 2); } catch { return ""; }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fallbackUpdaterState(note) {
  return { supported: Boolean(TAURI_INVOKE), configured: false, currentVersion: "", pending: null, channel: "stable", endpoint: "", note };
}

function skillDescription(item) {
  const metadata = item?.metadata || {};
  const candidates = [
    metadata.descriptionZh,
    metadata.description_zh,
    metadata.descriptionCn,
    metadata.description_cn,
    metadata.zhDescription,
    metadata.zh_description,
    metadata.description,
  ];
  if (item?.source === "builtin" && BUILTIN_SKILL_DESCRIPTION_ZH[item.name]) {
    return BUILTIN_SKILL_DESCRIPTION_ZH[item.name];
  }
  const value = candidates.find((entry) => typeof entry === "string" && entry.trim());
  return value || "暂无描述";
}

function updaterSummaryText() {
  if (state.updaterBusy === "install") return "正在安装新版本";
  if (state.updaterBusy === "check") return "正在检查新版本";
  if (state.updater.pending?.version) return `发现新版本 ${state.updater.pending.version}`;
  if (!TAURI_INVOKE) return "当前环境不支持版本检查";
  return "可手动检查新版本";
}

function updaterDetailText() {
  if (state.updater.pending?.currentVersion) {
    return `可从 ${state.updater.pending.currentVersion} 更新到 ${state.updater.pending.version}`;
  }
  const note = String(state.updater.note || "").trim();
  if (!note) return "";
  if (note.includes("失败")) return note;
  return "";
}

async function invokeTauri(command, args = {}) {
  if (!TAURI_INVOKE) throw new Error("Tauri API unavailable");
  return TAURI_INVOKE(command, args);
}

async function fetchJson(url, init) {
  const response = await fetch(`${API_BASE}${url}`, init);
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch {
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    throw new Error(raw || "响应不是有效 JSON");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escAttr(value) {
  return esc(value).replaceAll("'", "&#39;");
}
