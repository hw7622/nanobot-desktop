const tabs = [
  ["overview", "概览", "状态、版本和入口"],
  ["ai", "AI 配置", "Provider、模型与推理参数"],
  ["channels", "渠道配置", "Telegram / 飞书 / 钉钉等"],
  ["mcp", "MCP", "Server、超时与工具白名单"],
  ["skills", "Skills", "内置与工作区技能清单"],
  ["runtime", "运行控制", "启动、停止、日志与诊断"],
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
};

const API_BASE = (() => {
  if (typeof window !== "undefined" && typeof window.__NANOBOT_API_BASE__ === "string") {
    return window.__NANOBOT_API_BASE__;
  }
  if (typeof location !== "undefined" && location.protocol.startsWith("http")) {
    return "";
  }
  return "http://127.0.0.1:18791";
})();

const TAURI_INVOKE = window.__TAURI__?.core?.invoke;

const els = {
  nav: document.getElementById("nav"),
  content: document.getElementById("content"),
  title: document.getElementById("pageTitle"),
  saveBtn: document.getElementById("saveBtn"),
  saveState: document.getElementById("saveState"),
  gatewayDot: document.getElementById("gatewayDot"),
  gatewayLabel: document.getElementById("gatewayLabel"),
  versionMeta: document.getElementById("versionMeta"),
};

init();

async function init() {
  els.saveBtn.addEventListener("click", saveConfig);
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
      state.bootstrapError = `正在等待桌面后端启动...（第 ${attempt + 1} 次）`;
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
  render();
}

async function refreshRuntime() {
  if (!state.bootstrap) return;
  try {
    const payload = await fetchJson("/api/bootstrap");
    state.bootstrap.status = payload.status;
    state.bootstrap.skills = payload.skills;
    await refreshLogs();
    renderHeader();
    if (state.tab === "overview" || state.tab === "runtime" || state.tab === "skills") renderBody();
  } catch (error) {
    state.bootstrapError = `运行状态刷新失败：${error.message || error}`;
    renderHeader();
    if (state.tab === "overview" || state.tab === "runtime") renderBody();
  }
}

async function refreshLogs() {
  const payload = await fetchJson("/api/logs?name=gateway&lines=220");
  state.logs = payload.lines || [];
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

async function saveConfig() {
  if (!state.draft) {
    window.alert("桌面后端尚未就绪，请稍等几秒后重试。");
    return;
  }
  const payload = await fetchJson("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.draft),
  });
  state.bootstrap.config = payload.config;
  state.bootstrap.skills = payload.skills;
  state.draft = clone(payload.config);
  render();
}

async function gatewayAction(action) {
  await fetchJson(`/api/gateway/${action}`, { method: "POST" });
  await refreshRuntime();
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
      render();
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
  els.gatewayLabel.textContent = running
    ? `Gateway 运行中 · PID ${state.bootstrap.status.pid}`
    : "Gateway 未运行";
  els.versionMeta.textContent = `Desktop ${state.bootstrap.meta.desktopVersion} · Nanobot ${state.bootstrap.meta.nanobotVersion}`;
  els.saveBtn.disabled = !isDirty();
  els.saveState.textContent = isDirty() ? "有未保存的修改" : "配置已同步";
}

function renderBody() {
  if (!state.bootstrap || !state.draft) {
    renderShellLoading();
    return;
  }
  const pages = {
    overview: pageOverview,
    ai: pageAi,
    channels: pageChannels,
    mcp: pageMcp,
    skills: pageSkills,
    runtime: pageRuntime,
  };
  els.content.innerHTML = pages[state.tab]();
  bindPage();
}

function pageOverview() {
  const channels = enabledChannels();
  const mcpCount = Object.keys(state.draft.tools.mcpServers || {}).length;
  return `
    <div class="page-grid">
      <div class="stat-grid">
        <article class="stat-card"><p class="eyebrow">配置文件</p><strong>1</strong><p class="muted">${esc(state.bootstrap.meta.configPath)}</p></article>
        <article class="stat-card"><p class="eyebrow">已启用渠道</p><strong>${channels.length}</strong><p class="muted">${channels.join(" / ") || "尚未启用"}</p></article>
        <article class="stat-card"><p class="eyebrow">MCP Servers</p><strong>${mcpCount}</strong><p class="muted">命令行与远程协议在这里统一配置</p></article>
        <article class="stat-card"><p class="eyebrow">可见 Skills</p><strong>${state.bootstrap.skills.items.length}</strong><p class="muted">内置与工作区技能一并统计</p></article>
      </div>
      <div class="split-panel">
        <section class="panel">
          <p class="eyebrow">Quick Control</p>
          <h3>当前运行状态</h3>
          <p class="muted">先保存配置，再启动 Gateway，然后就可以通过你启用的聊天渠道指挥电脑执行任务。</p>
          <div class="button-row">
            <button class="button button-primary" data-gateway="start">启动 Gateway</button>
            <button class="button" data-gateway="restart">重启 Gateway</button>
            <button class="button button-danger" data-gateway="stop">停止 Gateway</button>
          </div>
          <div class="table-note">工作区：${esc(state.draft.agents.defaults.workspace)}</div>
          <div class="table-note">默认模型：${esc(state.draft.agents.defaults.model)}</div>
        </section>
        ${renderUpdaterPanel()}
      </div>
      <section class="panel">
        <p class="eyebrow">Gateway Tail</p>
        <h3>最近日志</h3>
        <pre class="pre">${esc(logText())}</pre>
      </section>
    </div>
  `;
}

function pageAi() {
  const providers = state.bootstrap.schema.providers;
  const current = providers.find((item) => item.key === state.provider) || providers[0];
  return `
    <div class="page-grid">
      <section class="panel">
        <p class="eyebrow">Provider Switchboard</p>
        <h3>AI 提供方</h3>
        <div class="provider-chip-row">
          ${providers.map((item) => `<button class="provider-chip ${item.key === current.key ? "active" : ""}" data-provider="${item.key}">${item.label}</button>`).join("")}
        </div>
      </section>
      <div class="split-panel">
        <section class="panel"><p class="eyebrow">Agent Defaults</p><h3>默认模型与推理</h3><div class="form-grid">${renderFields(state.draft.agents.defaults, state.bootstrap.schema.agents, "agents.defaults")}</div></section>
        <section class="panel"><p class="eyebrow">Credentials</p><h3>${current.label} 配置</h3><div class="form-grid">${renderFields(state.draft.providers[current.key] || {}, current.fields, `providers.${current.key}`)}</div></section>
      </div>
      <section class="panel">
        <p class="eyebrow">Web Tools</p>
        <h3>搜索与执行工具</h3>
        <div class="form-grid">
          ${renderFields(state.draft.tools.web, state.bootstrap.schema.tools.web, "tools.web")}
          ${renderFields(state.draft.tools.exec, state.bootstrap.schema.tools.exec, "tools.exec")}
          ${renderFields(state.draft.tools, state.bootstrap.schema.tools.root, "tools")}
        </div>
      </section>
    </div>
  `;
}

function pageChannels() {
  return `
    <div class="page-grid">
      <section class="panel">
        <p class="eyebrow">Channels</p>
        <h3>聊天渠道配置</h3>
        <p class="muted">首版保留 Telegram、飞书、钉钉、Email、QQ、企业微信。每个渠道一张卡片，方便逐项填写。</p>
      </section>
      <div class="channel-grid">
        ${state.bootstrap.schema.channels.map((channel) => {
          const cfg = state.draft.channels[channel.key] || clone(channel.defaultConfig);
          return `<article class="channel-card"><div class="card-head"><div><p class="eyebrow">${channel.key}</p><h4>${channel.label}</h4></div><span class="pill">${cfg.enabled ? "已启用" : "未启用"}</span></div><div class="form-grid">${renderFields(cfg, channel.fields, `channels.${channel.key}`)}</div></article>`;
        }).join("")}
      </div>
    </div>
  `;
}

function pageMcp() {
  const servers = state.draft.tools.mcpServers || {};
  const names = Object.keys(servers);
  return `
    <div class="page-grid">
      <section class="panel">
        <div class="card-head"><div><p class="eyebrow">Model Context Protocol</p><h3>MCP Servers</h3></div><button class="button button-primary" id="addMcpBtn">新增 Server</button></div>
        <p class="muted">MVP 先覆盖类型、命令、参数、URL、Headers、工具超时与白名单。</p>
      </section>
      <div class="mcp-list">
        ${names.length ? names.map((name) => mcpCard(name, servers[name])).join("") : `<div class="empty">还没有配置 MCP Server，可以先添加一个本地 filesystem 或远程 streamableHttp 服务。</div>`}
      </div>
    </div>
  `;
}

function pageSkills() {
  const skills = state.bootstrap.skills;
  return `
    <div class="page-grid">
      <section class="panel">
        <p class="eyebrow">Skills Directory</p>
        <h3>技能总览</h3>
        <div class="table-note">工作区：${esc(skills.workspace)}</div>
        <div class="table-note">自定义 skills 目录：${esc(skills.skillsDirectory)}</div>
      </section>
      <div class="skills-grid">
        ${skills.items.map((item) => `<article class="channel-card"><div class="card-head"><div><p class="eyebrow">${esc(item.source)}</p><h4>${esc(item.name)}</h4></div><span class="pill">${item.available ? "可用" : "缺依赖"}</span></div><p class="muted">${esc(item.metadata.description || "无额外描述")}</p><div class="table-note">always: ${item.always ? "true" : "false"}</div><div class="table-note">${esc(item.path)}</div></article>`).join("")}
      </div>
    </div>
  `;
}

function pageRuntime() {
  return `
    <div class="page-grid">
      <section class="panel">
        <p class="eyebrow">Runtime</p>
        <h3>Gateway 控制</h3>
        <div class="button-row">
          <button class="button button-primary" data-gateway="start">启动</button>
          <button class="button" data-gateway="restart">重启</button>
          <button class="button button-danger" data-gateway="stop">停止</button>
          <button class="button" id="refreshLogsBtn">刷新日志</button>
        </div>
        <div class="table-note">状态：${state.bootstrap.status.running ? `运行中（PID ${state.bootstrap.status.pid}）` : "未运行"}</div>
        <div class="table-note">日志：${esc(state.bootstrap.status.logPath || "")}</div>
      </section>
      ${renderUpdaterPanel()}
      <section class="panel"><p class="eyebrow">Gateway Log</p><h3>最近输出</h3><pre class="pre">${esc(logText())}</pre></section>
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
      <div class="updater-meta-row">
        <span class="pill ${updater.configured ? "pill-ok" : "pill-warn"}">${updater.configured ? "已配置" : "待配置"}</span>
        <span class="pill">通道 ${esc(updater.channel || "stable")}</span>
      </div>
      <div class="table-note">当前版本：${esc(updater.currentVersion || state.bootstrap.meta.desktopVersion)}</div>
      <div class="table-note">更新源：${esc(updater.endpoint || "未配置")}</div>
      ${pending ? `<div class="update-highlight"><strong>发现新版本 ${esc(pending.version)}</strong><p>${esc(pending.body || "GitHub Release 中存在新安装包，可执行安装。")}</p></div>` : `<div class="empty">${updater.configured ? "还没有检查到新版本。" : "先配置 updater 公钥，再发布签名过的 Release。"}</div>`}
      <p class="muted">${esc(updater.note || "")}</p>
      <div class="button-row">
        <button class="button button-primary" id="checkUpdatesBtn" ${checking || installing ? "disabled" : ""}>${checking ? "检查中..." : "检查更新"}</button>
        <button class="button" id="installUpdateBtn" ${!pending || checking || installing ? "disabled" : ""}>${installing ? "安装中..." : "安装更新"}</button>
      </div>
    </section>
  `;
}

function mcpCard(name, server) {
  return `
    <article class="mcp-card">
      <div class="card-head"><div><p class="eyebrow">MCP Server</p><h4>${esc(name)}</h4></div><button class="button button-danger" data-remove-mcp="${escAttr(name)}">移除</button></div>
      <div class="form-grid">
        ${fieldHtml(`mcp.${name}.name`, "名称", name, { readonly: true })}
        ${selectHtml(`mcp.${name}.type`, "类型", server.type || "stdio", [{label:"stdio", value:"stdio"}, {label:"sse", value:"sse"}, {label:"streamableHttp", value:"streamableHttp"}])}
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
  for (const button of document.querySelectorAll("[data-gateway]")) {
    button.onclick = () => gatewayAction(button.dataset.gateway);
  }
  for (const button of document.querySelectorAll("[data-provider]")) {
    button.onclick = () => {
      state.provider = button.dataset.provider;
      applyValue("agents.defaults.provider", state.provider);
      render();
    };
  }
  document.getElementById("refreshLogsBtn")?.addEventListener("click", async () => {
    await refreshLogs();
    renderBody();
  });
  document.getElementById("checkUpdatesBtn")?.addEventListener("click", checkUpdates);
  document.getElementById("installUpdateBtn")?.addEventListener("click", installUpdate);
  document.getElementById("addMcpBtn")?.addEventListener("click", () => {
    const name = window.prompt("请输入 MCP Server 名称");
    if (!name) return;
    state.draft.tools.mcpServers ||= {};
    if (!state.draft.tools.mcpServers[name]) state.draft.tools.mcpServers[name] = clone(state.bootstrap.schema.mcpServerTemplate);
    render();
  });
  for (const button of document.querySelectorAll("[data-remove-mcp]")) {
    button.onclick = () => {
      delete (state.draft.tools.mcpServers || {})[button.dataset.removeMcp];
      render();
    };
  }
  for (const input of document.querySelectorAll("[data-field-path]")) {
    input.onchange = () => {
      const type = input.dataset.fieldType;
      const parser = input.dataset.parser;
      let value = input.value;
      if (type === "toggle") value = input.checked;
      if (type === "number") value = value === "" ? 0 : Number(value);
      if (parser === "list") value = value.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
      if (parser === "json") {
        try {
          value = value.trim() ? JSON.parse(value) : {};
        } catch (error) {
          window.alert(`JSON 格式错误：${error.message}`);
          input.focus();
          return;
        }
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

function toggleHtml(path, label, checked) {
  return `<div class="field"><label>${label}</label><label class="toggle"><input type="checkbox" data-field-path="${path}" data-field-type="toggle" ${checked ? "checked" : ""}><span>${checked ? "已开启" : "已关闭"}</span></label></div>`;
}

function fieldHtml(path, label, value, field) {
  const type = field.type === "number" ? "number" : field.type === "password" ? "password" : "text";
  return `<div class="field ${field.full ? "full" : ""}"><label>${label}</label>${help(field)}<input type="${type}" value="${escAttr(String(value ?? ""))}" data-field-path="${path}" data-field-type="${field.type === "number" ? "number" : "text"}" placeholder="${escAttr(field.placeholder || "")}" ${field.readonly ? "readonly" : ""}></div>`;
}

function textAreaHtml(path, label, value, field) {
  return `<div class="field full"><label>${label}</label>${help(field)}<textarea data-field-path="${path}" data-field-type="textarea" data-parser="${field.parser || ""}" placeholder="${escAttr(field.placeholder || "")}" ${field.readonly ? "readonly" : ""}>${esc(String(value ?? ""))}</textarea></div>`;
}

function selectHtml(path, label, value, options) {
  return `<div class="field"><label>${label}</label><select data-field-path="${path}" data-field-type="select">${options.map((option) => `<option value="${escAttr(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>`;
}

function help(field) {
  return field.help ? `<span class="field-help">${esc(field.help)}</span>` : "";
}

function enabledChannels() {
  return state.bootstrap.schema.channels.filter((item) => state.draft.channels?.[item.key]?.enabled).map((item) => item.key);
}

function logText() {
  return state.logs.length ? state.logs.join("\n") : "暂无日志输出";
}

function fallbackUpdaterState(note, supported = true) {
  return {
    supported,
    configured: false,
    channel: "stable",
    endpoint: "https://github.com/hw7622/nanobot-desktop/releases/latest/download/latest.json",
    pubkeyConfigured: false,
    currentVersion: state.bootstrap?.meta?.desktopVersion || "0.1.0",
    pending: null,
    note,
  };
}

function getPath(target, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
}

function applyValue(path, value) {
  const parts = path.split(".");
  if (parts[0] === "mcp") {
    state.draft.tools.mcpServers ||= {};
    const [, name, ...rest] = parts;
    setPath(state.draft.tools.mcpServers[name], rest, value);
    return;
  }
  setPath(state.draft, parts, value);
}

function setPath(target, parts, value) {
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (cursor[key] == null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function isDirty() {
  return state.bootstrap && state.draft && JSON.stringify(state.bootstrap.config) !== JSON.stringify(state.draft);
}

async function fetchJson(url, init) {
  const response = await fetch(`${API_BASE}${url}`, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function invokeTauri(command, args) {
  if (!TAURI_INVOKE) throw new Error("当前不在桌面安装版环境中");
  return TAURI_INVOKE(command, args);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asJson(value) {
  return JSON.stringify(value, null, 2);
}

function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escAttr(value) {
  return esc(value).replaceAll("'", "&#39;");
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
