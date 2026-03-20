
const tabs = [
  ["overview", "概览", "状态、入口和快捷动作"],
  ["chat", "聊天窗口", "查看真实会话和本地测试聊天"],
  ["ai", "AI 配置", "只保留小白最常改的核心项"],
  ["channels", "渠道配置", "Telegram / 飞书 / 钉钉等"],
  ["mcp", "MCP", "Server、超时与工具白名单"],
  ["skills", "Skills", "内置与工作区技能管理"],
  ["runtime", "运行控制", "Gateway、日志和诊断"],
];

const state = {
  tab: "overview",
  bootstrap: null,
  draft: null,
  provider: "openrouter",
  logs: [],
  updater: fallbackUpdaterState("正在读取更新状态..."),
  updaterBusy: "",
  bootstrapError: "",
  saveBusy: false,
  saveRestartBusy: false,
  restartRecommended: false,
  lastSaveMessage: "",
  sessions: [],
  selectedSessionKey: "desktop:console",
  selectedSession: null,
  selectedSessionItems: [],
  selectedSessionBusy: false,
  chatBusy: false,
  chatDraft: "",
  logScrollTop: 0,
  logStickBottom: true,
  chatScrollTop: 0,
  chatStickBottom: true,
};

const API_BASE = (() => {
  if (typeof window !== "undefined" && typeof window.__NANOBOT_API_BASE__ === "string") return window.__NANOBOT_API_BASE__;
  if (typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost") && location.port === "18791") return "";
  return "http://127.0.0.1:18791";
})();

const TAURI_INVOKE = window.__TAURI__?.core?.invoke;
const els = {
  nav: document.getElementById("nav"),
  content: document.getElementById("content"),
  title: document.getElementById("pageTitle"),
  saveBtn: document.getElementById("saveBtn"),
  saveRestartBtn: document.getElementById("saveRestartBtn"),
  saveState: document.getElementById("saveState"),
  gatewayDot: document.getElementById("gatewayDot"),
  gatewayLabel: document.getElementById("gatewayLabel"),
  versionMeta: document.getElementById("versionMeta"),
};

init();

async function init() {
  els.saveBtn.addEventListener("click", () => saveConfig({ restartAfterSave: false }));
  els.saveRestartBtn.addEventListener("click", () => saveConfig({ restartAfterSave: true }));
  renderShellLoading();
  try {
    await refreshBootstrapWithRetry();
    await refreshUpdaterState();
    setInterval(refreshRuntime, 5000);
  } catch (error) {
    state.bootstrapError = `桌面后端尚未就绪：${error.message || error}`;
    renderShellLoading();
    scheduleBootstrapRetry();
  }
}

async function refreshBootstrapWithRetry() {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await refreshBootstrap();
      state.bootstrapError = "";
      return;
    } catch (error) {
      lastError = error;
      state.bootstrapError = `正在等待桌面后端启动...（第 ${attempt + 1} 次）：${error.message || error}`;
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
      await refreshUpdaterState();
      setInterval(refreshRuntime, 5000);
    } catch (error) {
      state.bootstrapError = `桌面后端启动失败：${error.message || error}`;
      renderShellLoading();
      scheduleBootstrapRetry();
    }
  }, 3000);
}

async function refreshBootstrap() {
  state.bootstrap = await fetchJson("/api/bootstrap");
  state.draft = clone(state.bootstrap.config);
  state.provider = state.draft.agents.defaults.provider || "openrouter";
  await refreshLogs();
  await refreshSessions();
  if (!state.selectedSessionKey && state.sessions.length) state.selectedSessionKey = state.sessions[0].key;
  await refreshSelectedSession();
  render();
}

async function refreshRuntime() {
  if (!state.bootstrap) return;
  captureLogScroll();
  if (state.tab === "chat") captureChatScroll();
  try {
    const payload = await fetchJson("/api/bootstrap");
    state.bootstrap.status = payload.status;
    state.bootstrap.skills = payload.skills;
    state.bootstrap.meta = payload.meta;
    await refreshLogs();
    if (state.tab === "chat") {
      await refreshSessions();
      await refreshSelectedSession(false);
    }
    renderHeader();
    if (["overview", "runtime", "skills", "chat"].includes(state.tab)) renderBody();
  } catch (error) {
    state.bootstrapError = `运行状态刷新失败：${error.message || error}`;
    renderHeader();
  }
}

async function refreshLogs() {
  const payload = await fetchJson("/api/logs?name=gateway&lines=220");
  state.logs = payload.lines || [];
  if (state.bootstrap?.status && payload.archives) {
    state.bootstrap.status.logArchives = payload.archives;
  }
}

async function refreshSessions() {
  const payload = await fetchJson("/api/sessions");
  state.sessions = payload.items || [];
  if (!state.sessions.some((item) => item.key === state.selectedSessionKey)) {
    state.selectedSessionKey = state.sessions[0]?.key || "desktop:console";
  }
}

async function refreshSelectedSession(renderAfter = false) {
  if (!state.selectedSessionKey) return;
  try {
    const payload = await fetchJson(`/api/session?key=${encodeURIComponent(state.selectedSessionKey)}`);
    state.selectedSession = payload.session;
    state.selectedSessionItems = payload.items || [];
  } catch {
    state.selectedSession = null;
    state.selectedSessionItems = [];
  }
  if (renderAfter) renderBody();
}

async function refreshUpdaterState() {
  if (!TAURI_INVOKE) {
    state.updater = fallbackUpdaterState("浏览器调试模式不支持自动更新；安装版中会启用。", false);
    render();
    return;
  }
  try {
    state.updater = await invokeTauri("updater_status");
  } catch (error) {
    state.updater = fallbackUpdaterState(`读取更新状态失败：${error.message || error}`);
  }
  render();
}

async function saveConfig({ restartAfterSave }) {
  if (!state.draft) {
    window.alert("桌面后端尚未就绪，请稍等几秒后重试。");
    return;
  }
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
    state.lastSaveMessage = restartAfterSave ? "配置已保存，正在重启 Gateway..." : "配置已保存。关键配置建议重启 Gateway 后生效。";
    state.restartRecommended = !restartAfterSave;
    if (restartAfterSave) {
      await gatewayAction(state.bootstrap.status.running ? "restart" : "start", { renderAfter: false });
      state.lastSaveMessage = "配置已保存，并已重启 Gateway。";
      state.restartRecommended = false;
    }
    render();
  } finally {
    state.saveBusy = false;
    state.saveRestartBusy = false;
    renderHeader();
  }
}

async function gatewayAction(action, options = {}) {
  const payload = await fetchJson(`/api/gateway/${action}`, { method: "POST" });
  if (state.bootstrap) state.bootstrap.status = payload.status;
  await refreshLogs();
  if (["start", "restart"].includes(action)) {
    state.restartRecommended = false;
    if (!isDirty()) state.lastSaveMessage = "Gateway 已重新加载当前配置。";
  }
  if (options.renderAfter !== false) render();
}

async function checkUpdates() {
  if (!TAURI_INVOKE || state.updaterBusy) return;
  state.updaterBusy = "check";
  renderBody();
  try {
    state.updater = await invokeTauri("check_for_updates");
  } catch (error) {
    state.updater = { ...state.updater, note: `检查更新失败：${error.message || error}` };
  } finally {
    state.updaterBusy = "";
    render();
  }
}

async function installUpdate() {
  if (!TAURI_INVOKE || state.updaterBusy) return;
  state.updaterBusy = "install";
  renderBody();
  try {
    state.updater = await invokeTauri("install_update");
    state.updater.note = `${state.updater.note} 更新已安装，请关闭并重新打开应用。`;
  } catch (error) {
    state.updater = { ...state.updater, note: `安装更新失败：${error.message || error}` };
  } finally {
    state.updaterBusy = "";
    render();
  }
}

async function sendChatMessage() {
  if (state.selectedSessionKey !== "desktop:console") return;
  const content = state.chatDraft.trim();
  if (!content || state.chatBusy) return;
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
    window.alert(`发送失败：${error.message || error}`);
  } finally {
    state.chatBusy = false;
    renderBody();
  }
}
async function clearChatHistory() {
  if (state.selectedSessionKey !== "desktop:console" || state.chatBusy) return;
  if (!window.confirm("确定清空桌面内测试聊天记录吗？")) return;
  state.chatBusy = true;
  renderBody();
  try {
    const payload = await fetchJson("/api/chat/clear", { method: "POST" });
    state.selectedSessionItems = payload.items || [];
    state.chatStickBottom = true;
  } finally {
    state.chatBusy = false;
    renderBody();
  }
}

async function createSkill() {
  const name = window.prompt("请输入新 skill 名称，仅支持字母、数字、点、下划线和短横线");
  if (!name) return;
  try {
    const payload = await fetchJson("/api/skill/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    state.bootstrap.skills = payload.skills;
    state.lastSaveMessage = `已创建 skill：${payload.created.name}`;
    render();
  } catch (error) {
    window.alert(`创建 skill 失败：${error.message || error}`);
  }
}

async function deleteSkill(name) {
  if (!window.confirm(`确定删除 workspace skill '${name}' 吗？`)) return;
  try {
    const payload = await fetchJson("/api/skill/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    state.bootstrap.skills = payload.skills;
    state.lastSaveMessage = `已删除 skill：${name}`;
    render();
  } catch (error) {
    window.alert(`删除 skill 失败：${error.message || error}`);
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
    window.alert(`打开失败：${error.message || error}`);
  }
}

async function copyLogs() {
  await copyText(logText());
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      state.lastSaveMessage = "内容已复制到剪贴板。";
      renderHeader();
      return;
    }
  } catch {}
  window.prompt("请手动复制以下内容", text);
}

function render() {
  renderNav();
  renderHeader();
  renderBody();
}

function renderShellLoading() {
  els.title.textContent = "概览";
  els.gatewayDot.className = "status-dot";
  els.gatewayLabel.textContent = state.bootstrapError || "正在启动桌面后端...";
  els.versionMeta.textContent = state.updater?.currentVersion ? `Desktop ${state.updater.currentVersion}` : "正在准备运行环境";
  els.nav.innerHTML = "";
  els.saveBtn.disabled = true;
  els.saveRestartBtn.disabled = true;
  els.saveState.textContent = state.bootstrapError || "等待桌面后端响应";
  els.content.innerHTML = `<div class="empty startup-empty">${esc(state.bootstrapError || "正在初始化控制台，请稍候几秒...")}</div>`;
}

function renderNav() {
  els.nav.innerHTML = tabs.map(([id, label, hint]) => `
    <button class="nav-button ${state.tab === id ? "active" : ""}" data-tab="${id}">
      <strong>${label}</strong>
      <span>${hint}</span>
    </button>
  `).join("");
  for (const button of els.nav.querySelectorAll("[data-tab]")) {
    button.onclick = () => {
      state.tab = button.dataset.tab;
      if (state.tab === "chat") {
        state.chatStickBottom = true;
        state.chatScrollTop = 0;
        refreshSelectedSession(true);
      }
      else render();
    };
  }
}

function renderHeader() {
  if (!state.bootstrap) {
    renderShellLoading();
    return;
  }
  const current = tabs.find(([id]) => id === state.tab);
  const running = Boolean(state.bootstrap.status.running);
  els.title.textContent = current?.[1] || "概览";
  els.gatewayDot.className = `status-dot ${running ? "online" : "offline"}`;
  els.gatewayLabel.textContent = running ? `Gateway 运行中 · PID ${state.bootstrap.status.pid}` : "Gateway 未运行";
  els.versionMeta.textContent = `Desktop ${state.bootstrap.meta.desktopVersion} · Nanobot ${state.bootstrap.meta.nanobotVersion}`;
  const disableSave = state.saveBusy || state.saveRestartBusy || !isDirty();
  els.saveBtn.disabled = disableSave;
  els.saveRestartBtn.disabled = state.saveBusy || state.saveRestartBusy || (!isDirty() && !running);
  els.saveBtn.textContent = state.saveBusy ? "保存中..." : "保存配置";
  els.saveRestartBtn.textContent = state.saveRestartBusy ? "处理中..." : "保存并重启 Gateway";
  if (state.saveBusy || state.saveRestartBusy) els.saveState.textContent = "正在提交配置...";
  else if (isDirty()) els.saveState.textContent = "有未保存的修改";
  else if (state.restartRecommended) els.saveState.textContent = state.lastSaveMessage || "配置已保存，建议重启 Gateway 使 AI / 渠道修改生效。";
  else els.saveState.textContent = state.lastSaveMessage || "配置已同步";
}

function renderBody() {
  if (!state.bootstrap || !state.draft) {
    renderShellLoading();
    return;
  }
  const pages = { overview: pageOverview, chat: pageChat, ai: pageAi, channels: pageChannels, mcp: pageMcp, skills: pageSkills, runtime: pageRuntime };
  els.content.innerHTML = pages[state.tab]();
  bindPage();
  restoreLogScroll();
  restoreChatScroll();
}

function pageOverview() {
  const channels = enabledChannels();
  return `
    <div class="page-grid">
      ${state.restartRecommended ? `<div class="notice warn">${esc(state.lastSaveMessage || "配置已保存，建议重启 Gateway 使关键配置生效。")}</div>` : ""}
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">已启用渠道</p><strong>${channels.length}</strong><p class="muted">${channels.join(" / ") || "尚未启用"}</p></article>
        <article class="stat-card"><p class="eyebrow">会话数量</p><strong>${state.sessions.length}</strong><p class="muted">按 channel:chat_id 拆分</p></article>
        <article class="stat-card"><p class="eyebrow">MCP Servers</p><strong>${Object.keys(state.draft.tools.mcpServers || {}).length}</strong><p class="muted">远程能力入口</p></article>
        <article class="stat-card"><p class="eyebrow">Skills</p><strong>${state.bootstrap.skills.items.length}</strong><p class="muted">内置 + 工作区</p></article>
      </div>
      <div class="split-panel">
        <section class="panel stack">
          <div>
            <p class="eyebrow">Quick Start</p>
            <h3>上手路径</h3>
            <p class="muted">概览页只保留状态摘要和常用入口。Gateway 控制、自动更新和日志诊断统一放在“运行控制”里，避免功能重复。</p>
          </div>
          <div class="button-row">
            <button class="button button-primary" data-switch-tab="ai">先配 AI</button>
            <button class="button" data-switch-tab="channels">再配渠道</button>
            <button class="button" data-switch-tab="chat">查看聊天</button>
            <button class="button" data-switch-tab="runtime">运行控制</button>
          </div>
          <div class="step-list">
            <div class="mini-card"><p class="eyebrow">1</p><strong>AI 配置</strong><div class="table-note">优先填写地址、Key、模型名。</div></div>
            <div class="mini-card"><p class="eyebrow">2</p><strong>保存并重启</strong><div class="table-note">模型、渠道、MCP 改完建议立即重启 Gateway。</div></div>
            <div class="mini-card"><p class="eyebrow">3</p><strong>聊天验证</strong><div class="table-note">先用桌面测试聊天，再到 Telegram / 飞书实测。</div></div>
          </div>
        </section>
        <section class="panel stack">
          <div>
            <p class="eyebrow">Current Setup</p>
            <h3>当前摘要</h3>
            <p class="muted">路径信息改为按钮入口，避免长本地路径挤占空间。</p>
          </div>
          <div class="quick-grid">
            <div class="mini-card"><p class="eyebrow">Provider</p><strong>${esc(state.draft.agents.defaults.provider)}</strong></div>
            <div class="mini-card"><p class="eyebrow">模型</p><strong>${esc(state.draft.agents.defaults.model)}</strong></div>
            <div class="mini-card"><p class="eyebrow">Gateway</p><strong>${state.bootstrap.status.running ? "运行中" : "未运行"}</strong></div>
          </div>
          <div class="button-row">
            <button class="button" data-open-target="config">打开配置</button>
            <button class="button" data-open-target="workspace">打开工作区</button>
            <button class="button" data-open-target="logs">打开日志</button>
            <button class="button" data-open-target="skills">打开 Skills</button>
          </div>
          <div class="table-note">如需看运行日志、控制 Gateway 或检查更新，请进入“运行控制”。</div>
        </section>
      </div>
    </div>
  `;
}

function pageChat() {
  const selected = state.selectedSession;
  const readonly = selected ? selected.readonly : true;
  return `
    <div class="page-grid">
      <section class="panel stack">
        <div>
          <p class="eyebrow">Session Viewer</p>
          <h3>会话窗口</h3>
          <p class="muted">这里显示真实渠道会话。Telegram、飞书等都会按 channel:chat_id 自动分开保存；桌面测试聊天单独作为一条本地会话。</p>
        </div>
        <div class="chat-layout">
          <div class="panel stack">
            <div class="card-head align-start"><div><h4>会话列表</h4><p class="muted">同一 Telegram 私聊通常就是一条会话；群聊会是另一条。如果你想在同一 Telegram 私聊里人为拆多个会话，当前核心还不支持。</p></div></div>
            <div class="session-list">${renderSessionList()}</div>
          </div>
          <div class="panel chat-shell">
            <div class="card-head align-start"><div><h4>${esc(selected?.title || "未选择会话")}</h4><p class="muted">${esc(selected?.subtitle || "")}</p></div><div class="button-row">${readonly ? "" : `<button class="button button-small" id="clearChatBtn" ${state.chatBusy ? "disabled" : ""}>清空本地测试会话</button>`}</div></div>
            <div class="chat-feed" id="chatFeed">${renderChatFeed()}</div>
            ${readonly ? `<div class="notice">这是外部渠道会话的只读视图，方便你像聊天窗口一样看消息，不再只盯着日志。发送消息仍然在 Telegram / 飞书等客户端里进行。</div>` : `<div class="chat-compose"><textarea id="chatInput" placeholder="输入一条测试消息。Enter 发送，Shift+Enter 换行。">${esc(state.chatDraft)}</textarea><div class="button-row"><button class="button button-primary" id="sendChatBtn" ${state.chatBusy ? "disabled" : ""}>${state.chatBusy ? "发送中..." : "发送测试消息"}</button></div></div>`}
          </div>
        </div>
      </section>
    </div>
  `;
}
function pageAi() {
  const providers = state.bootstrap.schema.providers;
  const current = providers.find((item) => item.key === state.provider) || providers[0];
  const providerFields = current.fields || [];
  const basicProviderFields = providerFields.filter((field) => field.key !== "extraHeaders");
  const advancedProviderFields = providerFields.filter((field) => field.key === "extraHeaders");
  const advancedAgentFields = state.bootstrap.schema.agents.filter((field) => !["provider", "model"].includes(field.key));
  return `
    <div class="page-grid">
      <section class="panel stack">
        <div>
          <p class="eyebrow">Easy Setup</p>
          <h3>AI 快速接入</h3>
          <p class="muted">对大多数用户，只需要填三样：接口类型、模型名、Key。高级参数默认先别动。</p>
        </div>
        <div class="provider-chip-row">${providers.map((item) => `<button class="provider-chip ${item.key === current.key ? "active" : ""}" data-provider="${item.key}">${item.label}</button>`).join("")}</div>
      </section>
      <div class="split-panel">
        <section class="panel stack">
          <div><p class="eyebrow">Basic</p><h3>最小可用配置</h3><p class="field-hint">${esc(providerQuickHint(current.key))}</p></div>
          <div class="form-grid">
            ${renderFields(state.draft.agents.defaults, state.bootstrap.schema.agents.filter((field) => ["model"].includes(field.key)), "agents.defaults")}
            ${renderFields(state.draft.providers[current.key] || {}, basicProviderFields, `providers.${current.key}`)}
          </div>
        </section>
        <section class="panel stack">
          <div><p class="eyebrow">How To Think</p><h3>填写建议</h3></div>
          <div class="notice">如果你用的是自定义 OpenAI 兼容接口，模型名必须填写服务端真实支持的 model id，桌面端不会替你自动改名。</div>
          <div class="table-note">当前 Provider：${esc(current.label)}</div>
          <div class="table-note">典型输入：地址 / Key / 模型名</div>
          <div class="table-note">推荐顺序：先用聊天窗口里的“桌面测试聊天”验证，再去 Telegram 实测。</div>
        </section>
      </div>
      <details class="details-card">
        <summary>高级参数（一般不用改）</summary>
        <div class="stack"><div class="form-grid">
          ${renderFields(state.draft.agents.defaults, advancedAgentFields, "agents.defaults")}
          ${renderFields(state.draft.tools.web, state.bootstrap.schema.tools.web, "tools.web")}
          ${renderFields(state.draft.tools.exec, state.bootstrap.schema.tools.exec, "tools.exec")}
          ${renderFields(state.draft.tools, state.bootstrap.schema.tools.root, "tools")}
          ${renderFields(state.draft.providers[current.key] || {}, advancedProviderFields, `providers.${current.key}`)}
        </div></div>
      </details>
    </div>
  `;
}

function pageChannels() {
  return `
    <div class="page-grid">
      <section class="panel"><p class="eyebrow">Channels</p><h3>聊天渠道配置</h3><p class="muted">渠道卡片先保留完整配置；后面可以继续做每个渠道的“基础模式 / 高级模式”分层。</p></section>
      <div class="channel-grid">${state.bootstrap.schema.channels.map((channel) => {
        const cfg = state.draft.channels[channel.key] || clone(channel.defaultConfig);
        return `<article class="channel-card"><div class="card-head"><div><p class="eyebrow">${channel.key}</p><h4>${channel.label}</h4></div><span class="pill">${cfg.enabled ? "已启用" : "未启用"}</span></div><div class="form-grid">${renderFields(cfg, channel.fields, `channels.${channel.key}`)}</div></article>`;
      }).join("")}</div>
    </div>
  `;
}

function pageMcp() {
  const servers = state.draft.tools.mcpServers || {};
  const names = Object.keys(servers);
  return `
    <div class="page-grid">
      <section class="panel"><div class="card-head"><div><p class="eyebrow">Model Context Protocol</p><h3>MCP Servers</h3></div><button class="button button-primary" id="addMcpBtn">新增 Server</button></div><p class="muted">这里暂时仍保持工程化视图，后续可以继续做一键模板。</p></section>
      <div class="mcp-list">${names.length ? names.map((name) => mcpCard(name, servers[name])).join("") : `<div class="empty">还没有配置 MCP Server，可以先添加一个本地 filesystem 或远程 streamableHttp 服务。</div>`}</div>
    </div>
  `;
}

function pageSkills() {
  const skills = state.bootstrap.skills;
  return `
    <div class="page-grid">
      <section class="panel stack">
        <div class="card-head"><div><p class="eyebrow">Skills Directory</p><h3>技能管理</h3></div><div class="button-row"><button class="button button-primary" id="createSkillBtn">新增 Skill</button><button class="button" data-open-target="skills">打开目录</button></div></div>
        <div class="table-note">工作区：${esc(shortPath(skills.workspace))}</div>
        <div class="table-note">自定义 skills 目录：${esc(shortPath(skills.skillsDirectory))}</div>
      </section>
      <div class="skills-grid">${skills.items.map((item) => `<article class="channel-card"><div class="card-head align-start"><div><p class="eyebrow">${esc(item.source)}</p><h4>${esc(item.name)}</h4></div>${item.editable ? `<button class="button button-small button-danger" data-delete-skill="${escAttr(item.name)}">删除</button>` : `<span class="pill">内置</span>`}</div><p class="muted">${esc(item.metadata.description || "无额外描述")}</p><div class="table-note">always: ${item.always ? "true" : "false"}</div><div class="table-note">${esc(shortPath(item.path))}</div></article>`).join("")}</div>
    </div>
  `;
}

function pageRuntime() {
  const rotation = state.bootstrap.status.logRotation || { maxBytes: 0, maxArchives: 0 };
  const archives = state.bootstrap.status.logArchives || [];
  return `
    <div class="page-grid">
      <div class="split-panel">
        <section class="panel stack">
          <div><p class="eyebrow">Runtime</p><h3>Gateway 控制</h3><p class="muted">这里保留运维相关信息，避免和概览重复太多。</p></div>
          <div class="button-row"><button class="button button-primary" data-gateway="start">启动</button><button class="button" data-gateway="restart">重启</button><button class="button button-danger" data-gateway="stop">停止</button></div>
          <div class="table-note">状态：${state.bootstrap.status.running ? `运行中（PID ${state.bootstrap.status.pid}）` : "未运行"}</div>
          <div class="table-note">最近退出码：${state.bootstrap.status.lastExitCode ?? "无"}</div>
          <div class="table-note">日志轮转：单文件超过 ${Math.round(rotation.maxBytes / 1000)} KB 自动滚动，最多保留 ${rotation.maxArchives} 份旧文件</div>
          <div class="table-note">历史日志：${archives.length ? archives.length : 0} 份</div>
          <div class="button-row"><button class="button button-small" data-open-target="logs">打开日志目录</button><button class="button button-small" data-open-target="config">打开配置文件</button><button class="button button-small" data-open-target="workspace">打开工作区</button><button class="button button-small" id="copyLogsBtn">复制日志</button></div>
        </section>
        ${renderUpdaterPanel()}
      </div>
      <section class="panel stack"><div class="card-head align-start"><div><p class="eyebrow">Gateway Log</p><h3>最近输出</h3></div><button class="button button-small" id="refreshLogsBtn">刷新日志</button></div><pre class="pre compact" id="gatewayLogPre">${esc(logText())}</pre></section>
    </div>
  `;
}

function renderUpdaterPanel() {
  const updater = state.updater;
  const pending = updater.pending;
  const checking = state.updaterBusy === "check";
  const installing = state.updaterBusy === "install";
  return `
    <section class="panel updater-panel">
      <p class="eyebrow">Updater</p>
      <h3>自动更新</h3>
      <div class="updater-meta-row"><span class="pill ${updater.configured ? "pill-ok" : "pill-warn"}">${updater.configured ? "已配置" : "待配置"}</span><span class="pill">通道 ${esc(updater.channel || "stable")}</span></div>
      <div class="table-note">当前版本：${esc(updater.currentVersion || state.bootstrap.meta.desktopVersion)}</div>
      <div class="table-note">更新源：${esc(updater.endpoint || "未配置")}</div>
      ${pending ? `<div class="update-highlight"><strong>发现新版本 ${esc(pending.version)}</strong><p>${esc(pending.body || "GitHub Release 中存在新安装包，可执行安装。")}</p></div>` : `<div class="empty">${updater.configured ? "还没有检查到新版本。" : "先配置 updater 公钥，再发布签名过的 Release。"}</div>`}
      <p class="muted">${esc(updater.note || "")}</p>
      <div class="button-row"><button class="button button-primary" id="checkUpdatesBtn" ${checking || installing ? "disabled" : ""}>${checking ? "检查中..." : "检查更新"}</button><button class="button" id="installUpdateBtn" ${!pending || checking || installing ? "disabled" : ""}>${installing ? "安装中..." : "安装更新"}</button></div>
    </section>
  `;
}

function renderSessionList() {
  if (!state.sessions.length) return `<div class="empty">暂时没有会话。</div>`;
  return state.sessions.map((item) => `
    <button class="session-item ${item.key === state.selectedSessionKey ? "active" : ""}" data-session-key="${escAttr(item.key)}">
      <strong>${esc(item.title)}</strong>
      <span>${esc(item.subtitle || "")}</span>
      <small>${esc(formatUpdatedAt(item.updatedAt))}</small>
    </button>
  `).join("");
}

function renderChatFeed() {
  if (!state.selectedSessionItems.length) return `<div class="empty">当前会话还没有消息。</div>`;
  return state.selectedSessionItems.map((item) => `
    <article class="message-bubble ${escAttr(item.role || "assistant")}">
      <div class="message-meta"><span>${esc(roleLabel(item.role, item.name))}</span><span>${esc(shortTimestamp(item.timestamp))}</span></div>
      <div class="message-content">${renderMessageContent(item.content || "")}</div>
    </article>
  `).join("");
}
function mcpCard(name, server) {
  return `
    <article class="mcp-card">
      <div class="card-head"><div><p class="eyebrow">MCP Server</p><h4>${esc(name)}</h4></div><button class="button button-danger" data-remove-mcp="${escAttr(name)}">移除</button></div>
      <div class="form-grid">
        ${fieldHtml(`mcp.${name}.name`, "名称", name, { readonly: true })}
        ${selectHtml(`mcp.${name}.type`, "类型", server.type || "stdio", [{ label: "stdio", value: "stdio" }, { label: "sse", value: "sse" }, { label: "streamableHttp", value: "streamableHttp" }])}
        ${fieldHtml(`mcp.${name}.command`, "命令", server.command || "", {})}
        ${fieldHtml(`mcp.${name}.url`, "URL", server.url || "", {})}
        ${textAreaHtml(`mcp.${name}.args`, "参数", (server.args || []).join("\n"), { parser: "list", help: "每行一个参数" })}
        ${textAreaHtml(`mcp.${name}.enabledTools`, "启用工具", (server.enabledTools || []).join("\n"), { parser: "list", help: "每行一个；默认填 *" })}
        ${textAreaHtml(`mcp.${name}.headers`, "Headers", asJson(server.headers || {}), { parser: "json", help: "JSON 对象" })}
        ${textAreaHtml(`mcp.${name}.env`, "环境变量", asJson(server.env || {}), { parser: "json", help: "JSON 对象" })}
        ${fieldHtml(`mcp.${name}.toolTimeout`, "工具超时（秒）", server.toolTimeout ?? 30, { type: "number" })}
      </div>
    </article>
  `;
}

function bindPage() {
  for (const button of document.querySelectorAll("[data-gateway]")) button.onclick = () => gatewayAction(button.dataset.gateway);
  for (const button of document.querySelectorAll("[data-provider]")) button.onclick = () => { state.provider = button.dataset.provider; applyValue("agents.defaults.provider", state.provider); render(); };
  for (const button of document.querySelectorAll("[data-open-target]")) button.onclick = () => openTarget(button.dataset.openTarget);
  for (const button of document.querySelectorAll("[data-switch-tab]")) button.onclick = () => {
    state.tab = button.dataset.switchTab;
    if (state.tab === "chat") {
      state.chatStickBottom = true;
      state.chatScrollTop = 0;
      refreshSelectedSession(true);
      return;
    }
    render();
  };
  for (const button of document.querySelectorAll("[data-session-key]")) button.onclick = async () => {
    state.selectedSessionKey = button.dataset.sessionKey;
    state.chatStickBottom = true;
    state.chatScrollTop = 0;
    await refreshSelectedSession(true);
  };
  for (const button of document.querySelectorAll("[data-delete-skill]")) button.onclick = () => deleteSkill(button.dataset.deleteSkill);
  for (const button of document.querySelectorAll("[data-remove-mcp]")) button.onclick = () => { delete (state.draft.tools.mcpServers || {})[button.dataset.removeMcp]; state.restartRecommended = true; render(); };
  document.getElementById("refreshLogsBtn")?.addEventListener("click", async () => { captureLogScroll(); await refreshLogs(); renderBody(); });
  document.getElementById("copyLogsBtn")?.addEventListener("click", copyLogs);
  document.getElementById("checkUpdatesBtn")?.addEventListener("click", checkUpdates);
  document.getElementById("installUpdateBtn")?.addEventListener("click", installUpdate);
  document.getElementById("addMcpBtn")?.addEventListener("click", () => {
    const name = window.prompt("请输入 MCP Server 名称");
    if (!name) return;
    state.draft.tools.mcpServers ||= {};
    if (!state.draft.tools.mcpServers[name]) state.draft.tools.mcpServers[name] = clone(state.bootstrap.schema.mcpServerTemplate);
    state.restartRecommended = true;
    render();
  });
  document.getElementById("createSkillBtn")?.addEventListener("click", createSkill);
  document.getElementById("sendChatBtn")?.addEventListener("click", sendChatMessage);
  document.getElementById("clearChatBtn")?.addEventListener("click", clearChatHistory);

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

  const gatewayLogPre = document.getElementById("gatewayLogPre");
  if (gatewayLogPre) gatewayLogPre.addEventListener("scroll", captureLogScroll);
  const chatFeed = document.getElementById("chatFeed");
  if (chatFeed) chatFeed.addEventListener("scroll", captureChatScroll);

  for (const input of document.querySelectorAll("[data-field-path]")) {
    input.onchange = () => {
      const type = input.dataset.fieldType;
      const parser = input.dataset.parser;
      let value = input.value;
      if (type === "toggle") value = input.checked;
      if (type === "number") value = value === "" ? 0 : Number(value);
      if (parser === "list") value = value.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
      if (parser === "json") {
        try { value = value.trim() ? JSON.parse(value) : {}; }
        catch (error) { window.alert(`JSON 格式错误：${error.message}`); input.focus(); return; }
      }
      applyValue(input.dataset.fieldPath, value);
      renderHeader();
    };
  }
}

function renderFields(target, fields, base) {
  return fields.map((field) => {
    const value = getPath(target, field.key);
    const path = `${base}.${field.key}`;
    if (field.type === "toggle") return toggleHtml(path, field.label, Boolean(value));
    if (field.type === "select-provider") return selectHtml(path, field.label, value, state.bootstrap.schema.providers.map((item) => ({ label: item.label, value: item.key })));
    if (field.type === "select") return selectHtml(path, field.label, value, field.options || []);
    if (field.type === "textarea") return textAreaHtml(path, field.label, value ?? "", field);
    if (field.type === "list") return textAreaHtml(path, field.label, (value || []).join("\n"), { ...field, parser: "list" });
    if (field.type === "json") return textAreaHtml(path, field.label, asJson(value || {}), { ...field, parser: "json" });
    return fieldHtml(path, field.label, value ?? "", field);
  }).join("");
}

function toggleHtml(path, label, checked) { return `<div class="field"><label>${label}</label><label class="toggle"><input type="checkbox" data-field-path="${path}" data-field-type="toggle" ${checked ? "checked" : ""}><span>${checked ? "已开启" : "已关闭"}</span></label></div>`; }
function fieldHtml(path, label, value, field) { const type = field.type === "number" ? "number" : field.type === "password" ? "password" : "text"; return `<div class="field ${field.full ? "full" : ""}"><label>${label}</label>${help(field)}<input type="${type}" value="${escAttr(String(value ?? ""))}" data-field-path="${path}" data-field-type="${field.type === "number" ? "number" : "text"}" placeholder="${escAttr(field.placeholder || "")}" ${field.readonly ? "readonly" : ""}></div>`; }
function textAreaHtml(path, label, value, field) { return `<div class="field full"><label>${label}</label>${help(field)}<textarea data-field-path="${path}" data-field-type="textarea" data-parser="${field.parser || ""}" placeholder="${escAttr(field.placeholder || "")}" ${field.readonly ? "readonly" : ""}>${esc(String(value ?? ""))}</textarea></div>`; }
function selectHtml(path, label, value, options) { return `<div class="field"><label>${label}</label><select data-field-path="${path}" data-field-type="select">${options.map((option) => `<option value="${escAttr(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>`; }
function help(field) { return field.help ? `<span class="field-help">${esc(field.help)}</span>` : ""; }
function enabledChannels() { return state.bootstrap.schema.channels.filter((item) => state.draft.channels?.[item.key]?.enabled).map((item) => item.key); }
function logText() { return state.logs.length ? state.logs.join("\n") : "暂无日志输出"; }
function fallbackUpdaterState(note, supported = true) { return { supported, configured: false, channel: "stable", endpoint: "https://github.com/hw7622/nanobot-desktop/releases/latest/download/latest.json", pubkeyConfigured: false, currentVersion: "0.1.0", pending: null, note }; }
function getPath(target, path) { return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), target); }
function applyValue(path, value) { const parts = path.split("."); if (parts[0] === "mcp") { state.draft.tools.mcpServers ||= {}; const [, name, ...rest] = parts; setPath(state.draft.tools.mcpServers[name], rest, value); state.restartRecommended = true; return; } setPath(state.draft, parts, value); state.restartRecommended = true; }
function setPath(target, parts, value) { let cursor = target; for (let index = 0; index < parts.length - 1; index += 1) { const key = parts[index]; if (cursor[key] == null || typeof cursor[key] !== "object") cursor[key] = {}; cursor = cursor[key]; } cursor[parts[parts.length - 1]] = value; }
function isDirty() { return state.bootstrap && state.draft && JSON.stringify(state.bootstrap.config) !== JSON.stringify(state.draft); }
async function fetchJson(url, init) { const response = await fetch(`${API_BASE}${url}`, init); const raw = await response.text(); let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch { if (!response.ok) throw new Error(`Request failed: ${response.status}`); throw new Error(raw || "响应不是有效 JSON"); } if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`); return payload; }
async function invokeTauri(command, args) { if (!TAURI_INVOKE) throw new Error("当前不在桌面安装版环境中"); return TAURI_INVOKE(command, args); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function asJson(value) { return JSON.stringify(value, null, 2); }
function providerQuickHint(provider) { const hints = { custom: "只填接口地址、API Key 和模型名即可。非常适合 OpenAI 兼容中转或本地代理。", openrouter: "一般只需要 API Key 和模型名。模型名常见形如 anthropic/claude-3.7-sonnet。", ollama: "本地模型通常只填 API Base 和模型名，例如 http://localhost:11434 + qwen2.5:7b。" }; return hints[provider] || "建议先只填模型名和 Key，其他项保持默认。"; }
function roleLabel(role, name) { if (role === "user") return "你"; if (role === "assistant") return "Nanobot"; if (role === "tool") return `工具${name ? ` · ${name}` : ""}`; if (role === "system") return "系统"; return role || "消息"; }
function shortTimestamp(value) { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return date.toLocaleString("zh-CN", { hour12: false }); }
function shortPath(value) { const text = String(value || ""); if (text.length <= 40) return text; return `...${text.slice(-37)}`; }
function formatUpdatedAt(value) { return value ? `更新于 ${shortTimestamp(value)}` : "尚无消息"; }
function captureLogScroll() { const el = document.getElementById("gatewayLogPre"); if (!el) return; state.logScrollTop = el.scrollTop; const distance = el.scrollHeight - el.clientHeight - el.scrollTop; state.logStickBottom = distance < 24; }
function restoreLogScroll() { const el = document.getElementById("gatewayLogPre"); if (!el) return; requestAnimationFrame(() => { el.scrollTop = state.logStickBottom ? el.scrollHeight : state.logScrollTop; }); }
function captureChatScroll() { const el = document.getElementById("chatFeed"); if (!el) return; state.chatScrollTop = el.scrollTop; const distance = el.scrollHeight - el.clientHeight - el.scrollTop; state.chatStickBottom = distance < 24; }
function restoreChatScroll() { const el = document.getElementById("chatFeed"); if (!el) return; requestAnimationFrame(() => { el.scrollTop = state.chatStickBottom ? el.scrollHeight : state.chatScrollTop; }); }
function renderMessageContent(value) {
  const text = String(value || "");
  if (!text.trim()) return `<span class="muted">空消息</span>`;
  const chunks = [];
  const blockPattern = /```([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = blockPattern.exec(text))) {
    if (match.index > lastIndex) chunks.push(renderInlineMessage(text.slice(lastIndex, match.index)));
    chunks.push(`<pre class="inline-pre"><code>${esc(match[1].trim())}</code></pre>`);
    lastIndex = blockPattern.lastIndex;
  }
  if (lastIndex < text.length) chunks.push(renderInlineMessage(text.slice(lastIndex)));
  return chunks.join("") || `<span class="muted">空消息</span>`;
}
function renderInlineMessage(text) {
  const tokens = [];
  const pushToken = (html) => {
    const token = `__HTML_TOKEN_${tokens.length}__`;
    tokens.push(html);
    return token;
  };
  let html = esc(text);
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, url) => pushToken(imageHtml(url, alt || "图片")));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => pushToken(linkHtml(url, label)));
  html = html.replace(/(^|[\s(])((https?:\/\/[^\s<]+?\.(?:png|jpe?g|gif|webp))(?:\?[^\s<]*)?)/gim, (_, prefix, url) => `${prefix}${pushToken(imageHtml(url, "图片"))}`);
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/gim, (_, prefix, url) => `${prefix}${pushToken(linkHtml(url, url))}`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\n/g, "<br>");
  return tokens.reduce((acc, tokenHtml, index) => acc.replaceAll(`__HTML_TOKEN_${index}__`, tokenHtml), html);
}
function imageHtml(url, alt) { return `<figure class="inline-image"><img src="${escAttr(url)}" alt="${escAttr(alt)}" loading="lazy"><figcaption>${esc(alt)}</figcaption></figure>`; }
function linkHtml(url, label) { return `<a class="message-link" href="${escAttr(url)}" target="_blank" rel="noreferrer">${esc(label)}</a>`; }
function esc(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function escAttr(value) { return esc(value).replaceAll("'", "&#39;"); }
function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
